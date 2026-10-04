/**
 * Prediction engine for one event (station × day × high/low). Several approaches, each scored by the skill
 * tracker and combined by learned weights:
 *
 *   models    each deterministic NWP model's extreme over the rest of the day, debiased per station/lead
 *   blend     skill-weighted mean of the debiased models (Gaussian, sd = the blend's learned error)
 *   nowcast   the blend pulled toward today's observed model error, more strongly near the extreme's time
 *   ensemble  ECMWF/GEFS/ICON members, debiased and kernel-dressed to the ensemble's learned error
 *
 * The Gaussian (nowcast when available, else blend) and the ensemble are mixed with weights the expert mixer
 * learns per lead bin, then the observed extreme so far is applied as a floor (high) or ceiling (low).
 */
import { localDayBounds, leadBinFor, localDate } from "../time.js";
import {
  bucketIndexForValue, bucketProbs, dayExtremeCdf, distSummary, ensembleCdf, gaussianCdf, impossibleBuckets
} from "./distribution.js";
import { fromC, toC } from "./skill.js";

const NOWCAST_TAU_H = 6;
const MAX_NOWCAST_ERR_C = 3;
// Ensemble group (Open-Meteo key) → deterministic model whose learned bias it shares
const ENSEMBLE_PARENT = [[/ecmwf/i, "ecmwf_ifs025"], [/gefs|gfs|ncep/i, "gfs_seamless"], [/icon/i, "icon_seamless"], [/gem|cmc/i, "gem_seamless"], [/ukmo|mogreps/i, "ukmo_seamless"]];

const ext = (kind, arr) => (kind === "high" ? Math.max(...arr) : Math.min(...arr));

function interpAt(times, values, tMs) {
  let j = 0;
  while (j < times.length && times[j] <= tMs) j += 1;
  if (j === 0 || j === times.length) return null;
  const a = values[j - 1];
  const b = values[j];
  if (a === null || b === null) return null;
  return a + ((tMs - times[j - 1]) / (times[j] - times[j - 1])) * (b - a);
}

/** Values of an hourly series on [fromMs, toMs], plus the interpolated value at fromMs. */
export function windowValues(times, values, fromMs, toMs) {
  const out = [];
  for (let i = 0; i < times.length; i += 1) {
    if (values[i] !== null && times[i] >= fromMs && times[i] <= toMs) out.push(values[i]);
  }
  const v0 = interpAt(times, values, fromMs);
  if (v0 !== null) out.push(v0);
  return out;
}

/** Time of the extreme of the mean curve within [fromMs, toMs]. */
function extremeTime(kind, times, curves, fromMs, toMs) {
  let best = null;
  let bestT = fromMs;
  for (let i = 0; i < times.length; i += 1) {
    if (times[i] < fromMs || times[i] > toMs) continue;
    const vals = curves.map((c) => c[i]).filter((v) => v !== null);
    if (!vals.length) continue;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (best === null || (kind === "high" ? m > best : m < best)) {
      best = m;
      bestT = times[i];
    }
  }
  return bestT;
}

/**
 * Observations for the local day: { ext, n, latest, complete }. `obs` = [{ tMs, v }] in the market unit;
 * `official` = { max, min, asOfMs } when the source publishes running extremes (HKO).
 */
export function summarizeObs({ kind, obs = [], official = null, startMs, endMs, nowMs }) {
  const inDay = obs.filter((o) => o.tMs >= startMs && o.tMs < endMs && o.tMs <= nowMs);
  let e = inDay.length ? ext(kind, inDay.map((o) => o.v)) : null;
  if (official && Number.isFinite(official[kind === "high" ? "max" : "min"])) {
    const ov = official[kind === "high" ? "max" : "min"];
    e = e === null ? ov : ext(kind, [e, ov]);
  }
  const latest = inDay.length ? inDay[inDay.length - 1] : null;
  // Complete = no gap over 2h anywhere in the (elapsed part of the) day
  const stop = Math.min(nowMs, endMs);
  let complete;
  if (official?.asOfMs) complete = official.asOfMs >= Math.min(stop, endMs) - 30 * 60_000;
  else {
    const ts = [startMs, ...inDay.map((o) => o.tMs), stop];
    let gap = 0;
    for (let i = 1; i < ts.length; i += 1) gap = Math.max(gap, ts[i] - ts[i - 1]);
    complete = inDay.length > 0 && gap <= 2 * 3_600_000;
  }
  return { ext: e, n: inDay.length, latest, complete };
}

/**
 * @param {object} p
 * @param {object} p.event       parsed event (station, kind, date, unit, rule, buckets)
 * @param {string} p.tz          station IANA zone
 * @param {object|null} p.det    { times, models: { name: values[] } }
 * @param {object|null} p.ens    { times, members: values[][] }
 * @param {object} p.obsInfo     summarizeObs() result
 * @param {object} p.skill       skill tracker
 * @param {{ gauss: number, ens: number }} p.mix  expert weights for this lead bin
 */
export function buildForecast({ event, tz, det, ens, obsInfo, skill, mix = { gauss: 0.5, ens: 0.5 }, nowMs = Date.now() }) {
  const { kind, unit, rule, station, buckets } = event;
  // Whole-degree METAR observations (°C stations) add rounding noise (variance 1/12) to the learned errors;
  // the model distribution is for the continuous value, so take it back out.
  const roundVar = event.source === "metar" && unit === "C" ? 1 / 12 : 0;
  const { startMs, endMs } = localDayBounds(event.date, tz);
  const leadBin = leadBinFor(event.date, tz, nowMs);
  const hoursLeft = (endMs - nowMs) / 3_600_000;
  const started = nowMs >= startMs;
  const winStart = Math.max(nowMs, startMs);
  const obsExt = started ? obsInfo?.ext ?? null : null;
  const base = { leadBin, hoursLeft, startMs, endMs, winStart, obs: started ? obsInfo : null, today: localDate(nowMs, tz) };

  // Day over: the outcome is the observed extreme. Keep 1.5% on neighbours for data revisions / feed gaps.
  if (leadBin === "post") {
    if (obsExt === null) return { ...base, ok: false, reason: "no_obs_for_finished_day" };
    const idx = bucketIndexForValue(buckets, obsExt, rule);
    const p = buckets.map((_, i) => (i === idx ? 0.985 : Math.abs(i - idx) === 1 ? 0.0075 : 0));
    const total = p.reduce((a, b) => a + b, 0);
    const pWx = p.map((x) => x / total);
    return {
      ...base, ok: true, confident: Boolean(obsInfo?.complete), pWx, pG: pWx, pE: null, mixUsed: { gauss: 1, ens: 0 },
      impossible: impossibleBuckets(buckets, kind, obsExt, rule), approaches: { observed: obsExt }, predictions: null,
      summary: distSummary(buckets, pWx)
    };
  }

  // ---- deterministic models over the remaining window
  const models = {};
  const curves = [];
  if (det?.times?.length) {
    for (const [name, values] of Object.entries(det.models)) {
      const w = windowValues(det.times, values, winStart, endMs);
      if (w.length < 2) continue;
      const raw = ext(kind, w);
      const sk = skill.get(station, kind, `model:${name}`, leadBin);
      models[name] = { raw, mu: raw - fromC(sk.bias, unit), sd: sk.sd, n: sk.n };
      curves.push(values);
    }
  }
  const names = Object.keys(models);
  if (!names.length && !ens?.members?.length) return { ...base, ok: false, reason: "no_forecast" };

  const approaches = { models };
  const predictions = {};
  for (const n of names) predictions[`model:${n}`] = models[n].raw;

  let gauss = null;
  if (names.length) {
    // Inverse-variance weights (sd in °C), floored so no single model dominates
    let sw = 0;
    let swx = 0;
    for (const n of names) {
      const w = 1 / Math.max(0.25, models[n].sd) ** 2;
      models[n].w = w;
      sw += w;
      swx += w * models[n].mu;
    }
    const blendRaw = swx / sw;
    const bs = skill.get(station, kind, "blend", leadBin);
    const blend = { raw: blendRaw, mu: blendRaw - fromC(bs.bias, unit), sd: fromC(bs.sd, unit), n: bs.n };
    approaches.blend = blend;
    predictions.blend = blendRaw;
    gauss = { mu: blend.mu, sd: blend.sd, source: "blend" };

    // Nowcast: today's observed error vs the raw model mean, decaying with hours to the extreme's time
    const latest = obsInfo?.latest;
    if (started && latest && nowMs - latest.tMs < 2 * 3_600_000) {
      const vals = Object.values(det.models).map((v) => interpAt(det.times, v, latest.tMs)).filter((v) => v !== null);
      if (vals.length) {
        const meanAt = vals.reduce((a, b) => a + b, 0) / vals.length;
        const maxErr = fromC(MAX_NOWCAST_ERR_C, unit);
        const err = Math.max(-maxErr, Math.min(maxErr, latest.v - meanAt));
        const tExt = extremeTime(kind, det.times, curves, winStart, endMs);
        const rho = Math.exp(-Math.max(0, tExt - latest.tMs) / 3_600_000 / NOWCAST_TAU_H);
        const rawMean = names.reduce((a, n) => a + models[n].raw, 0) / names.length;
        const nowRaw = rawMean + rho * err + (1 - rho) * (blendRaw - rawMean);
        const ns = skill.get(station, kind, "nowcast", leadBin, { fallback: ["blend"] });
        const nowcast = { raw: nowRaw, mu: nowRaw - fromC(ns.bias, unit), sd: fromC(ns.sd, unit), n: ns.n, err, rho };
        approaches.nowcast = nowcast;
        predictions.nowcast = nowRaw;
        gauss = { mu: nowcast.mu, sd: nowcast.sd, source: "nowcast" };
      }
    }
  }

  // ---- ensemble members over the remaining window. Each member is first debiased with its parent
  // deterministic model's learned bias (raw ensembles share the models' cold bias on highs), then by the
  // ensemble's own residual bias, then dressed to the ensemble's learned error.
  let ensDist = null;
  if (ens?.members?.length) {
    const groupBias = new Map();
    const biasFor = (group) => {
      if (!groupBias.has(group)) {
        const parent = ENSEMBLE_PARENT.find(([re]) => re.test(group))?.[1];
        groupBias.set(group, parent ? fromC(skill.get(station, kind, `model:${parent}`, leadBin).bias, unit) : 0);
      }
      return groupBias.get(group);
    };
    const raw = [];
    const debiased = [];
    ens.members.forEach((m, j) => {
      const w = windowValues(ens.times, m, winStart, endMs);
      if (w.length < 2) return;
      const r = ext(kind, w);
      raw.push(r);
      debiased.push(r - biasFor(ens.groups?.[j] ?? ""));
    });
    if (debiased.length >= 5) {
      const mean = debiased.reduce((a, b) => a + b, 0) / debiased.length;
      const spread = Math.sqrt(debiased.reduce((a, v) => a + (v - mean) ** 2, 0) / (debiased.length - 1));
      const es = skill.get(station, kind, "ensemble", leadBin, { fallback: ["blend"] });
      const residual = -fromC(es.bias, unit);
      const nc = approaches.nowcast;
      // With a nowcast, today's observed error replaces (part of) the learned debiasing, as for the blend
      const members = debiased.map((d, j) => (nc ? raw[j] + nc.rho * nc.err + (1 - nc.rho) * (d - raw[j] + residual) : d + residual));
      const target = Math.sqrt(Math.max(0.04, fromC(es.sd, unit) ** 2 - roundVar));
      const h = Math.sqrt(Math.max((unit === "F" ? 0.5 : 0.3) ** 2, target ** 2 - spread ** 2));
      ensDist = { members, h };
      const mu = members.reduce((a, b) => a + b, 0) / members.length;
      approaches.ensemble = { raw: mean, mu, spread, h, n: members.length, nSkill: es.n };
      predictions.ensemble = mean;
    }
  }

  const obsCdf = (cdf) => dayExtremeCdf(kind, obsExt, cdf);
  const pG = gauss ? bucketProbs(buckets, obsCdf(gaussianCdf(gauss.mu, Math.sqrt(Math.max(0.04, gauss.sd ** 2 - roundVar)))), rule) : null;
  const pE = ensDist ? bucketProbs(buckets, obsCdf(ensembleCdf(ensDist.members, ensDist.h)), rule) : null;
  let mixUsed = { gauss: 1, ens: 0 };
  if (pG && pE) mixUsed = { gauss: mix.gauss / (mix.gauss + mix.ens), ens: mix.ens / (mix.gauss + mix.ens) };
  else if (pE) mixUsed = { gauss: 0, ens: 1 };
  const pWx = buckets.map((_, i) => (pG ? mixUsed.gauss * pG[i] : 0) + (pE ? mixUsed.ens * pE[i] : 0));
  approaches.gauss = gauss;

  return {
    ...base,
    ok: true,
    confident: true,
    pWx,
    pG,
    pE,
    mixUsed,
    impossible: impossibleBuckets(buckets, kind, obsExt, rule),
    approaches,
    predictions: { winStartMs: winStart, values: predictions },
    summary: distSummary(buckets, pWx)
  };
}

/** Realized extreme of `obs` over [fromMs, endMs) for skill learning, or null if coverage is too thin. */
export function realizedExtreme(kind, obs, fromMs, endMs) {
  const xs = obs.filter((o) => o.tMs >= fromMs && o.tMs < endMs);
  if (!xs.length) return null;
  const ts = [fromMs, ...xs.map((o) => o.tMs), endMs];
  let gap = 0;
  for (let i = 1; i < ts.length; i += 1) gap = Math.max(gap, ts[i] - ts[i - 1]);
  if (gap > 2.5 * 3_600_000) return null;
  return ext(kind, xs.map((o) => o.v));
}

export { toC };
