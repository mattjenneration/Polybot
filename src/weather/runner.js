/**
 * Weather trader — paper trading Polymarket daily high/low temperature markets in learning mode.
 *   npm run sim:weather        (pm2 app "weather-sim"; dashboard at /weather.html)
 *
 * Each tick (30s):
 *   discover events (Gamma) → observations (METAR / HKO) → forecasts (Open-Meteo multi-model + ensemble)
 *   → per event: forecast distribution, market-implied distribution, learned blend → order books for buckets
 *   where the model and market disagree → strategies decide → paper fills
 * At each local day's end the realized extreme trains the forecast skill tracker; when Polymarket resolves an
 * event it settles positions and trains the model/market calibrator, the expert mixer, and the strategy,
 * city, timing and maker-fill learners.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WCFG } from "./config.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import { errorToRedactedLogString } from "../logRedact.js";
import { appendCsvRow, ensureDir, sleep } from "../utils.js";
import { normalizeBook } from "../core/orderbook.js";
import { takerFeePerShare } from "../core/fees.js";
import { fetchBooks } from "../markets/gamma.js";
import { eventResolution, fetchEventBySlug, fetchTemperatureEvents } from "./events.js";
import { createStationRegistry } from "./stations.js";
import { cToUnit, fetchMetars } from "./sources/metar.js";
import { fetchHkoCurrent, fetchHkoSinceMidnight } from "./sources/hko.js";
import { fetchEnsembleForecast, fetchModelForecast } from "./sources/openMeteo.js";
import { buildForecast, realizedExtreme, summarizeObs } from "./model/forecast.js";
import { createSkillTracker, toC } from "./model/skill.js";
import { calibratorFeatures, createCalibrator } from "./model/calibrator.js";
import { marketView, mirrorBook } from "./model/market.js";
import { bucketIndexForValue, logLoss } from "./model/distribution.js";
import { createExpertMixer } from "./strategy/learning.js";
import { createWeatherEngine } from "./engine.js";
import { backfillStations } from "./backfill.js";
import { leadBinFor, localDayBounds } from "./time.js";

const BIN_ORDER = ["post", "d0d", "d0c", "d0b", "d0a", "d1", "d2", "d3"];
const OBS_RETENTION_MS = 4 * 86_400_000;
const r4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r4a = (arr) => (Array.isArray(arr) ? arr.map(r4) : null);
const fmt = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "" : Number(x).toFixed(d));

/** Cap buckets that observations have ruled out, then renormalize. */
export function applyObsVeto(p, impossible, cap = 0.002) {
  if (!impossible?.some(Boolean)) return p;
  const q = p.map((x, i) => (impossible[i] ? Math.min(x, cap) : x));
  const z = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / z);
}

export function createWeatherSim({ cfg = WCFG, log = (...a) => console.log(`[weather ${new Date().toISOString()}]`, ...a) } = {}) {
  const dir = cfg.logDir;
  ensureDir(dir);
  const files = {
    state: path.join(dir, "state.json"),
    samples: path.join(dir, "samples.json"),
    stations: path.join(dir, "stations.json"),
    dashboard: path.join(dir, "dashboard.json"),
    controls: path.join(dir, "controls.json"),
    trades: path.join(dir, "trades.csv"),
    settlements: path.join(dir, "settlements.csv"),
    outcomes: path.join(dir, "outcomes.csv"),
    snapshots: path.join(dir, "snapshots")
  };
  const learningOn = cfg.learning.enabled;
  const registry = createStationRegistry({ file: files.stations });
  const skill = createSkillTracker();
  const calibrator = createCalibrator({ learningRate: cfg.learning.calibratorLr });
  const mixer = createExpertMixer();
  const engine = createWeatherEngine({
    strategyIds: cfg.sim.strategies,
    bankrollUsd: cfg.sim.bankrollUsd,
    shadowStakeUsd: cfg.sim.shadowStakeUsd,
    caps: { maxEventPct: cfg.sim.maxEventExposurePct, maxOpenPct: cfg.sim.maxOpenExposurePct },
    learning: { enabled: learningOn, minEvents: cfg.learning.minEvents, lcbZ: cfg.learning.lcbZ },
    takerMaxBookAgeMs: cfg.loop.bookMaxAgeSec * 1000,
    onFill: (f) => {
      log(`FILL ${f.strategyId} ${f.side} "${f.city} ${f.kind} ${f.date} ${f.label}" ${f.execution} @${fmt(f.avgPrice, 3)} $${fmt(f.cost, 2)} p=${fmt(f.pSide, 3)} edge=${fmt(f.edge, 3)} [${f.leadBin}]`);
      appendCsvRow(files.trades, [
        "timestamp", "strategy", "event_slug", "city", "kind", "date", "bucket", "side", "execution", "lead_bin", "avg_price",
        "shares", "cost_usd", "fee_usd", "p_side", "p_market_side", "edge", "variant"
      ], [
        new Date(f.openedAt).toISOString(), f.strategyId, f.slug, f.city, f.kind, f.date, f.label, f.side, f.execution, f.leadBin,
        fmt(f.avgPrice), fmt(f.shares), fmt(f.cost), fmt(f.fee, 5), fmt(f.pSide), fmt(f.pMarketSide), fmt(f.edge), f.variantId ?? ""
      ]);
    },
    onSettle: (s) => {
      appendCsvRow(files.settlements, [
        "settled_at", "strategy", "event_slug", "city", "kind", "date", "bucket", "side", "execution", "lead_bin", "avg_price",
        "shares", "cost_usd", "fee_usd", "p_side", "p_market_side", "edge", "won", "payout_usd", "pnl_usd", "cash_after", "variant"
      ], [
        new Date(s.settledAt).toISOString(), s.strategyId, s.slug, s.city, s.kind, s.date, s.label, s.side, s.execution, s.leadBin,
        fmt(s.avgPrice), fmt(s.shares), fmt(s.cost), fmt(s.fee, 5), fmt(s.pSide), fmt(s.pMarketSide), fmt(s.edge), String(s.won),
        fmt(s.payout), fmt(s.pnl), fmt(s.cashAfter, 2), s.variantId ?? ""
      ]);
    }
  });

  let events = new Map(); // id → parsed event from the latest discovery
  const tracked = new Map(); // id → event summary kept until settled
  const forecasts = new Map(); // station → { det, detAt, ens, ensAt }
  const obs = new Map(); // station → Map(tMs → °C)
  const official = new Map(); // "HKO|date" → { max, min, asOfMs }
  const books = new Map(); // yes token → { rx, bids, asks }
  const mktHistory = new Map(); // eventId → [{ ts, p }]
  const samples = new Map(); // eventId → calibrator checkpoints
  const predictions = new Map(); // eventId → { bin: { winStartMs, values } }
  const lastSampleAt = new Map();
  const lastSnapshotAt = new Map();
  const backfillTried = new Set();
  const backfillDone = new Set();
  const status = {
    startedAt: new Date().toISOString(), discovery: null, metarOkAt: 0, hkoOkAt: 0, errors: {}, backfill: null,
    outcomeCheck: { n: 0, match: 0, mismatches: [] }, lastSettlements: []
  };
  const timers = { discover: 0, metar: 0, resolution: 0, save: 0, summaryLog: 0 };
  let lastResetSeen = null;
  let lastBuilt = [];

  const err = (where, e) => {
    status.errors[where] = { at: new Date().toISOString(), msg: errorToRedactedLogString(e).slice(0, 300) };
    log(`${where}: ${status.errors[where].msg}`);
  };

  // ---------------------------------------------------------------- persistence
  function save() {
    const write = (file, data) => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    };
    try {
      write(files.state, {
        version: 1, savedAt: new Date().toISOString(), engine: engine.toJSON(), skill: skill.toJSON(),
        calibrator: calibrator.toJSON(), mixer: mixer.toJSON(), tracked: Object.fromEntries(tracked),
        outcomeCheck: status.outcomeCheck, lastResetSeen
      });
      write(files.samples, {
        samples: Object.fromEntries(samples), predictions: Object.fromEntries(predictions), mktHistory: Object.fromEntries(mktHistory),
        obs: Object.fromEntries([...obs].map(([k, m]) => [k, [...m]])), official: Object.fromEntries(official)
      });
    } catch (e) {
      err("save", e);
    }
  }

  /** Restore saved state; returns false when there was none (fresh start) or it couldn't be read. */
  function load() {
    try {
      if (!fs.existsSync(files.state)) return false;
      const st = JSON.parse(fs.readFileSync(files.state, "utf8"));
      if (st.engine) engine.restore(st.engine);
      skill.restore(st.skill);
      calibrator.restore(st.calibrator);
      mixer.restore(st.mixer);
      for (const [k, v] of Object.entries(st.tracked ?? {})) tracked.set(k, v);
      if (st.outcomeCheck) status.outcomeCheck = st.outcomeCheck;
      lastResetSeen = st.lastResetSeen ?? null;
      if (fs.existsSync(files.samples)) {
        const sm = JSON.parse(fs.readFileSync(files.samples, "utf8"));
        for (const [k, v] of Object.entries(sm.samples ?? {})) samples.set(k, v);
        for (const [k, v] of Object.entries(sm.predictions ?? {})) predictions.set(k, v);
        for (const [k, v] of Object.entries(sm.mktHistory ?? {})) mktHistory.set(k, v);
        for (const [k, v] of Object.entries(sm.obs ?? {})) obs.set(k, new Map(v.map(([t, c]) => [Number(t), Number(c)])));
        for (const [k, v] of Object.entries(sm.official ?? {})) official.set(k, v);
      }
      return true;
    } catch (e) {
      err("load", e);
      return false;
    }
  }

  function checkControls() {
    try {
      if (!fs.existsSync(files.controls)) return;
      const c = JSON.parse(fs.readFileSync(files.controls, "utf8"));
      // lastResetSeen is persisted, so a restart doesn't replay an old request
      if (c.resetRequestedAt && c.resetRequestedAt !== lastResetSeen) {
        engine.resetAccounts();
        lastResetSeen = c.resetRequestedAt;
        log("paper bankrolls reset (learning kept)");
      }
    } catch {
      // ignore malformed control file
    }
  }

  // ---------------------------------------------------------------- data refresh
  async function discover(nowMs) {
    const { events: list, unparsed } = await fetchTemperatureEvents({ tags: cfg.tags });
    const wantCity = (c) => !cfg.cities.length || cfg.cities.some((x) => x.toLowerCase() === c.toLowerCase());
    const kept = list.filter((e) => cfg.kinds.includes(e.kind) && wantCity(e.city));
    events = new Map(kept.map((e) => [e.id, e]));
    for (const e of kept) {
      if (tracked.has(e.id)) continue;
      tracked.set(e.id, {
        id: e.id, slug: e.slug, city: e.city, kind: e.kind, date: e.date, station: e.station, source: e.source, unit: e.unit,
        rule: e.rule, firstSeenMs: nowMs, lastCheckMs: 0, learned: false,
        buckets: e.buckets.map((b) => ({ marketId: b.marketId, label: b.label, lo: b.lo, hi: b.hi }))
      });
    }
    status.discovery = { at: new Date(nowMs).toISOString(), events: kept.length, unparsed, stations: new Set(kept.map((e) => e.station)).size };
    const ids = [...new Set(kept.map((e) => e.station))].filter((id) => id !== "HKO");
    await registry.ensure(ids);
    for (const e of kept) registry.setUnit(e.station, e.unit);
  }

  function mergeObs(station, list) {
    const m = obs.get(station) ?? new Map();
    for (const o of list) m.set(o.tMs, o.c);
    obs.set(station, m);
  }

  async function pollObs(nowMs) {
    // Listed events plus closed-but-unlearned ones (their day's last reports are still needed for learning)
    const sources = [...events.values(), ...[...tracked.values()].filter((t) => !t.learned)];
    const metarIds = [...new Set(sources.filter((e) => e.source === "metar").map((e) => e.station))];
    const deep = nowMs - status.metarOkAt > 2.5 * 3_600_000;
    const got = await fetchMetars(metarIds, deep ? { hours: 30, batch: 6 } : { hours: 3, batch: 25 });
    for (const [id, list] of got) mergeObs(id, list);
    status.metarOkAt = nowMs;
    if (sources.some((e) => e.source === "hko")) {
      try {
        const [sm, cur] = await Promise.all([fetchHkoSinceMidnight(), fetchHkoCurrent()]);
        if (sm) official.set(`HKO|${sm.date}`, { max: sm.max, min: sm.min, asOfMs: sm.asOfMs });
        if (cur) mergeObs("HKO", [cur]);
        status.hkoOkAt = nowMs;
      } catch (e) {
        err("hko", e);
      }
    }
    for (const m of obs.values()) for (const t of m.keys()) if (t < nowMs - OBS_RETENTION_MS) m.delete(t);
    for (const [k, v] of official) if (v.asOfMs < nowMs - OBS_RETENTION_MS) official.delete(k);
  }

  async function refreshForecasts(nowMs) {
    const need = new Map(); // station → unit
    for (const e of events.values()) {
      const st = registry.get(e.station);
      if (st && leadBinFor(e.date, st.tz, nowMs) !== "post") need.set(e.station, e.unit);
    }
    const stale = (at, min) => !at || nowMs - at > min * 60_000;
    const order = [...need.keys()].sort((a, b) => (forecasts.get(a)?.detAt ?? 0) - (forecasts.get(b)?.detAt ?? 0));
    let det = 0;
    let ens = 0;
    for (const id of order) {
      const st = registry.get(id);
      const f = forecasts.get(id) ?? {};
      const unit = need.get(id);
      if (det < 12 && stale(f.detAt, cfg.loop.forecastMin)) {
        det += 1;
        try {
          f.det = await fetchModelForecast({ lat: st.lat, lon: st.lon, unit, models: cfg.models });
          f.detAt = nowMs;
        } catch (e) {
          err(`forecast:${id}`, e);
        }
      }
      if (ens < 6 && stale(f.ensAt, cfg.loop.ensembleMin)) {
        ens += 1;
        try {
          f.ens = await fetchEnsembleForecast({ lat: st.lat, lon: st.lon, unit, models: cfg.ensembleModels });
          f.ensAt = nowMs;
        } catch (e) {
          f.ensAt = nowMs - (cfg.loop.ensembleMin - 30) * 60_000; // retry in 30 min
          err(`ensemble:${id}`, e);
        }
      }
      forecasts.set(id, f);
    }
  }

  /** Market distribution ~1–3h ago, for the momentum feature. */
  function marketRef(eventId, nowMs) {
    const h = mktHistory.get(eventId) ?? [];
    const ref = [...h].reverse().find((x) => nowMs - x.ts >= 3_600_000 && nowMs - x.ts <= 3 * 3_600_000);
    return ref?.p ?? null;
  }

  // ---------------------------------------------------------------- per-event model + context
  function buildAll(nowMs) {
    const out = [];
    const maxAge = cfg.loop.bookMaxAgeSec * 1000;
    for (const e of events.values()) {
      const st = registry.get(e.station);
      if (!st) continue;
      const f = forecasts.get(e.station) ?? {};
      const { startMs, endMs } = localDayBounds(e.date, st.tz);
      const list = [...(obs.get(e.station) ?? new Map())].map(([tMs, c]) => ({ tMs, v: cToUnit(c, e.unit) })).sort((a, b) => a.tMs - b.tMs);
      const off = e.source === "hko" ? official.get(`HKO|${e.date}`) ?? null : null;
      const obsInfo = summarizeObs({ kind: e.kind, obs: list, official: off, startMs, endMs, nowMs });
      const bin = leadBinFor(e.date, st.tz, nowMs);
      const fc = buildForecast({ event: e, tz: st.tz, det: f.det, ens: f.ens, obsInfo, skill, mix: mixer.weights(bin), nowMs });
      const mv = marketView(e, books, nowMs, maxAge);
      let probs = { wx: null, market: mv.pMkt, final: null };
      let tradeable = false;
      let reason = null;
      let pPrev = null;
      if (!fc.ok) reason = fc.reason;
      else {
        pPrev = marketRef(e.id, nowMs);
        const xs = calibratorFeatures({ pWx: fc.pWx, pMkt: mv.pMkt, pMktPrev: pPrev, leadBin: fc.leadBin });
        probs = { wx: fc.pWx, market: mv.pMkt, final: applyObsVeto(calibrator.predict(xs), fc.impossible) };
        const d0 = fc.leadBin.startsWith("d0");
        const latestObsMs = e.source === "hko" ? off?.asOfMs : obsInfo.latest?.tMs;
        if (!fc.confident) reason = "obs_incomplete";
        else if (awaitingBackfill(e.station)) reason = "awaiting_backfill";
        else if (fc.leadBin !== "post" && (!f.detAt || nowMs - f.detAt > 3 * 3_600_000)) reason = "stale_forecast";
        else if (d0 && (!latestObsMs || nowMs - latestObsMs > 2 * 3_600_000)) reason = "stale_obs";
        else if (mv.quality === "none") reason = "no_market";
        else if (!e.buckets.some((b) => b.accepting)) reason = "not_accepting";
        else tradeable = true;
      }
      const ctx = {
        eventId: e.id, slug: e.slug, city: e.city, kind: e.kind, date: e.date, key: e.key, leadBin: fc.leadBin ?? bin,
        hoursLeft: (endMs - nowMs) / 3_600_000, tradeable, reason, probs,
        buckets: e.buckets.map((b) => {
          const bk = books.get(b.yesTokenId);
          const fresh = Boolean(bk && b.accepting && nowMs - bk.rx <= maxAge);
          return {
            marketId: b.marketId, label: b.label, tick: b.tick, minSize: b.minSize, feeSchedule: b.feeSchedule, bookRx: bk?.rx ?? null,
            yes: fresh ? { bids: bk.bids, asks: bk.asks } : null, no: fresh ? mirrorBook(bk) : null
          };
        })
      };
      out.push({ e, st, fc, mv, probs, pPrev, ctx, obsInfo, f });
    }
    return out;
  }

  /** Fetch YES books where a strategy could act: model/market disagreement, resting bids, the d1 favourite. */
  async function refreshBooks(built, nowMs) {
    const resting = engine.restingMarketIds();
    const want = [];
    for (const { e, probs, mv, ctx } of built) {
      if (!ctx.tradeable) continue;
      const urgent = ctx.leadBin.startsWith("d0") || ctx.leadBin === "post";
      const minAge = urgent ? 25_000 : 110_000;
      const fav = probs.market ? probs.market.indexOf(Math.max(...probs.market)) : -1;
      e.buckets.forEach((b, i) => {
        if (!b.accepting) return;
        const bk = books.get(b.yesTokenId);
        if (bk && nowMs - bk.rx < minAge) return;
        const mid = mv.rows[i].mid;
        const interesting = resting.has(b.marketId) || mid === null
          || Math.abs((probs.final?.[i] ?? mid) - mid) >= 0.015 || Math.abs((probs.wx?.[i] ?? mid) - mid) >= 0.03
          || (ctx.leadBin === "d1" && i === fav);
        if (interesting) want.push({ id: b.yesTokenId, urgent });
      });
    }
    want.sort((a, b) => Number(b.urgent) - Number(a.urgent));
    const ids = want.slice(0, 600).map((w) => w.id);
    if (!ids.length) return 0;
    const got = await fetchBooks(ids);
    for (const [id, raw] of got) books.set(id, { rx: nowMs, ...normalizeBook(raw, 25) });
    for (const [id, b] of books) if (nowMs - b.rx > 3_600_000) books.delete(id);
    return got.size;
  }

  // ---------------------------------------------------------------- learning bookkeeping
  function recordCheckpoints(built, nowMs) {
    for (const { e, fc, mv, probs, pPrev, obsInfo, f } of built) {
      if (!fc.ok) continue;
      // Only learn from forecasts built on fresh data and backfilled skill (a prior-only blend would
      // poison the blend's learned bias), and only train the calibrator where there is a market price.
      const trusted = !awaitingBackfill(e.station) && (fc.leadBin === "post" || (f.detAt && nowMs - f.detAt <= 3 * 3_600_000));
      const hist = mktHistory.get(e.id) ?? [];
      if (mv.pMkt && (!hist.length || nowMs - hist[hist.length - 1].ts >= 30 * 60_000)) {
        hist.push({ ts: nowMs, p: r4a(mv.pMkt) });
        if (hist.length > 8) hist.shift();
        mktHistory.set(e.id, hist);
      }
      const d0 = fc.leadBin.startsWith("d0") || fc.leadBin === "post";
      const every = (d0 ? 60 : 120) * 60_000;
      if (trusted && fc.confident && probs.market && nowMs - (lastSampleAt.get(e.id) ?? 0) >= every) {
        lastSampleAt.set(e.id, nowMs);
        const list = samples.get(e.id) ?? [];
        list.push({ ts: nowMs, bin: fc.leadBin, pWx: r4a(probs.wx), pMkt: r4a(probs.market), pPrev, pFinal: r4a(probs.final), pG: r4a(fc.pG), pE: r4a(fc.pE) });
        if (list.length > 72) list.shift();
        samples.set(e.id, list);
      }
      if (trusted && fc.predictions) {
        const p = predictions.get(e.id) ?? {};
        if (!p[fc.leadBin]) {
          p[fc.leadBin] = { winStartMs: fc.predictions.winStartMs, values: Object.fromEntries(Object.entries(fc.predictions.values).map(([k, v]) => [k, r4(v)])) };
          predictions.set(e.id, p);
        }
      }
      if (cfg.snapshots && nowMs - (lastSnapshotAt.get(e.id) ?? 0) >= cfg.loop.snapshotMin * 60_000) {
        lastSnapshotAt.set(e.id, nowMs);
        const a = fc.approaches ?? {};
        const line = {
          ts: new Date(nowMs).toISOString(), id: e.id, slug: e.slug, city: e.city, kind: e.kind, date: e.date, station: e.station, unit: e.unit,
          bin: fc.leadBin, hoursLeft: r4(fc.hoursLeft), obsExt: obsInfo?.ext ?? null, nObs: obsInfo?.n ?? 0,
          blend: a.blend && { mu: r4(a.blend.mu), sd: r4(a.blend.sd) }, nowcast: a.nowcast && { mu: r4(a.nowcast.mu), rho: r4(a.nowcast.rho), err: r4(a.nowcast.err) },
          ens: a.ensemble && { mu: r4(a.ensemble.mu), spread: r4(a.ensemble.spread), n: a.ensemble.n }, mix: fc.mixUsed,
          models: Object.fromEntries(Object.entries(a.models ?? {}).map(([k, v]) => [k, r4(v.raw)])),
          detAgeMin: f.detAt ? Math.round((nowMs - f.detAt) / 60_000) : null,
          labels: e.buckets.map((b) => b.label), bid: mv.rows.map((r) => r.bid), ask: mv.rows.map((r) => r.ask),
          pWx: r4a(probs.wx), pMkt: r4a(probs.market), pFinal: r4a(probs.final)
        };
        try {
          ensureDir(files.snapshots);
          fs.appendFileSync(path.join(files.snapshots, `${line.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`);
        } catch (e2) {
          err("snapshot", e2);
        }
      }
    }
  }

  /** After a local day ends: observed extreme → skill tracker (forecast − realized, per recorded lead bin). */
  function learnOutcome(t, nowMs, { force = false } = {}) {
    if (t.learned) return;
    const st = registry.get(t.station);
    if (!st) return;
    const { startMs, endMs } = localDayBounds(t.date, st.tz);
    if (!force && nowMs < endMs + 90 * 60_000) return;
    t.learned = true;
    const list = [...(obs.get(t.station) ?? new Map())].map(([tMs, c]) => ({ tMs, v: cToUnit(c, t.unit) })).sort((a, b) => a.tMs - b.tMs);
    let finalExt = null;
    if (t.source === "hko") {
      const off = official.get(`HKO|${t.date}`);
      if (off && off.asOfMs >= endMs - 30 * 60_000) finalExt = t.kind === "high" ? off.max : off.min;
    } else finalExt = realizedExtreme(t.kind, list, startMs, endMs);
    t.observed = finalExt;
    if (finalExt === null) return;
    const idx = bucketIndexForValue(t.buckets, finalExt, t.rule);
    t.observedBucket = idx >= 0 ? t.buckets[idx].label : null;
    if (!learningOn) return;
    for (const [bin, p] of Object.entries(predictions.get(t.id) ?? {})) {
      const realized = t.source === "hko" ? (p.winStartMs <= startMs ? finalExt : null) : realizedExtreme(t.kind, list, p.winStartMs, endMs);
      if (realized === null) continue;
      for (const [src, v] of Object.entries(p.values)) if (v !== null) skill.update(t.station, t.kind, src, bin, toC(v - realized, t.unit));
    }
  }

  function settle(t, r, nowMs) {
    learnOutcome(t, nowMs, { force: true });
    const resolved = r.status === "resolved";
    const winnerIdx = resolved ? t.buckets.findIndex((b) => b.marketId === r.winnerMarketId) : -1;
    const settled = engine.settleEvent({ eventId: t.id, winnerMarketId: resolved ? r.winnerMarketId : null, city: t.city, kind: t.kind, nowMs });
    if (resolved && winnerIdx >= 0) {
      const ss = samples.get(t.id) ?? [];
      calibrator.learnEvent(ss.map((s) => ({
        xs: calibratorFeatures({ pWx: s.pWx, pMkt: s.pMkt, pMktPrev: s.pPrev, leadBin: s.bin }), pWx: s.pWx, pMkt: s.pMkt, pFinal: s.pFinal, leadBin: s.bin
      })), winnerIdx, `${t.city}|${t.kind}`, { train: learningOn });
      if (learningOn) {
        const byBin = new Map();
        for (const s of ss) {
          if (!s.pG || !s.pE) continue;
          const b = byBin.get(s.bin) ?? { gauss: 0, ens: 0, n: 0 };
          b.gauss += logLoss(s.pG, winnerIdx);
          b.ens += logLoss(s.pE, winnerIdx);
          b.n += 1;
          byBin.set(s.bin, b);
        }
        for (const [bin, b] of byBin) mixer.record(bin, { gauss: b.gauss / b.n, ens: b.ens / b.n });
      }
      const match = t.observedBucket === null || t.observedBucket === undefined ? "" : String(t.observedBucket === r.winnerLabel);
      if (match) {
        status.outcomeCheck.n += 1;
        if (match === "true") status.outcomeCheck.match += 1;
        else status.outcomeCheck.mismatches = [...status.outcomeCheck.mismatches, `${t.city} ${t.kind} ${t.date}: observed ${t.observed} → ${t.observedBucket}, resolved ${r.winnerLabel}`].slice(-10);
      }
      appendCsvRow(files.outcomes, ["timestamp", "event_id", "slug", "city", "kind", "date", "station", "observed", "observed_bucket", "resolved_bucket", "match"], [
        new Date(nowMs).toISOString(), t.id, t.slug, t.city, t.kind, t.date, t.station, t.observed ?? "", t.observedBucket ?? "", r.winnerLabel, match
      ]);
    }
    const pnl = settled.reduce((a, s) => a + s.pnl, 0);
    status.lastSettlements = [{ at: new Date(nowMs).toISOString(), city: t.city, kind: t.kind, date: t.date, result: resolved ? r.winnerLabel : "void", positions: settled.length, pnl }, ...status.lastSettlements].slice(0, 30);
    if (settled.length) log(`SETTLED ${t.city} ${t.kind} ${t.date} → ${resolved ? r.winnerLabel : "void"}: ${settled.length} positions, pnl $${pnl.toFixed(2)}`);
    tracked.delete(t.id);
    samples.delete(t.id);
    predictions.delete(t.id);
    mktHistory.delete(t.id);
    lastSampleAt.delete(t.id);
    lastSnapshotAt.delete(t.id);
  }

  async function checkResolutions(nowMs) {
    const due = [];
    for (const t of tracked.values()) {
      const st = registry.get(t.station);
      if (!st) continue;
      const { endMs } = localDayBounds(t.date, st.tz);
      if (nowMs < endMs) continue;
      learnOutcome(t, nowMs);
      const live = events.get(t.id);
      // Still listed as open with every bucket trading: nothing to settle yet
      if (live && !live.buckets.some((b) => b.closed) && nowMs - endMs < 2 * 86_400_000) continue;
      if (nowMs - t.lastCheckMs < cfg.loop.resolutionCheckMin * 60_000) continue;
      due.push({ t, endMs });
    }
    due.sort((a, b) => a.t.lastCheckMs - b.t.lastCheckMs);
    for (const { t, endMs } of due.slice(0, 40)) {
      t.lastCheckMs = nowMs;
      try {
        const r = eventResolution(await fetchEventBySlug(t.slug));
        if (r.status !== "open") settle(t, r, nowMs);
        else if (nowMs - endMs > 12 * 86_400_000) settle(t, { status: "void" }, nowMs);
      } catch (e) {
        err(`resolution:${t.slug}`, e);
      }
    }
  }

  const backfillEnabled = () => learningOn && cfg.learning.autoBackfill && cfg.learning.backfillDays > 0;
  /** Don't trade a station on prior-only skill (cold-biased raw models) while its history backfill is pending. */
  const awaitingBackfill = (station) => backfillEnabled() && skill.samples(station) < 40 && !backfillDone.has(station);

  function maybeBackfill() {
    if (!backfillEnabled() || status.backfill?.running) return;
    const list = [];
    for (const e of events.values()) {
      if (backfillTried.has(e.station)) continue;
      const st = registry.get(e.station);
      if (!st) continue;
      backfillTried.add(e.station);
      if (skill.samples(e.station) < 40) list.push({ station: st, unit: e.unit });
      else backfillDone.add(e.station);
    }
    if (!list.length) return;
    log(`backfilling forecast skill for ${list.length} stations (${cfg.learning.backfillDays} days of history)`);
    status.backfill = { running: true, total: list.length, done: 0 };
    backfillStations({
      stations: list, skill, days: cfg.learning.backfillDays, log,
      onProgress: (s) => {
        const { learned, ...rest } = s;
        status.backfill = rest;
        for (const id of learned) backfillDone.add(id);
      }
    })
      // Stations whose history couldn't be fetched stay gated until live learning reaches 40 samples (~1 day)
      .then(() => save())
      .catch((e) => err("backfill", e));
  }

  // ---------------------------------------------------------------- dashboard
  function bestEdge(ctx) {
    let best = null;
    const p = ctx.probs.final;
    if (!p) return null;
    ctx.buckets.forEach((b, i) => {
      for (const side of ["YES", "NO"]) {
        const book = side === "YES" ? b.yes : b.no;
        const ask = book?.asks[0]?.[0];
        if (ask === undefined) continue;
        const ps = side === "YES" ? p[i] : 1 - p[i];
        const edge = ps - ask - takerFeePerShare(ask, b.feeSchedule);
        if (!best || edge > best.edge) best = { label: b.label, side, ask, p: ps, edge };
      }
    });
    return best;
  }

  function dashboard(built, nowMs) {
    const board = built.map(({ e, fc, mv, probs, ctx, obsInfo }) => ({
      id: e.id, slug: e.slug, city: e.city, kind: e.kind, date: e.date, station: e.station, unit: e.unit, bin: ctx.leadBin,
      hoursLeft: r4(ctx.hoursLeft), tradeable: ctx.tradeable, reason: ctx.reason, obsExt: obsInfo?.ext ?? null, nObs: obsInfo?.n ?? 0,
      fcMean: r4(fc.summary?.mean), fcSd: r4(fc.summary?.sd), gauss: fc.approaches?.gauss?.source ?? null,
      nowcast: fc.approaches?.nowcast ? { err: r4(fc.approaches.nowcast.err), rho: r4(fc.approaches.nowcast.rho) } : null,
      mktMean: r4(mv.implied?.mean), quality: mv.quality, volume: Math.round(e.volume),
      buckets: e.buckets.map((b, i) => ({ label: b.label, wx: r4(probs.wx?.[i]), mkt: r4(probs.market?.[i]), fin: r4(probs.final?.[i]), bid: mv.rows[i].bid, ask: mv.rows[i].ask })),
      best: bestEdge(ctx)
    })).sort((a, b) => BIN_ORDER.indexOf(a.bin) - BIN_ORDER.indexOf(b.bin) || a.city.localeCompare(b.city) || a.kind.localeCompare(b.kind));
    const sim = engine.summary({ includeCurves: true, cities: [...new Set(built.map((b) => `${b.e.city}|${b.e.kind}`))] });
    const evById = new Map(built.map((b) => [b.e.id, b.e]));
    const label = (eventId, marketId) => {
      const t = tracked.get(eventId) ?? evById.get(eventId);
      const b = t?.buckets.find((x) => x.marketId === marketId);
      return { event: t ? `${t.city} ${t.kind} ${t.date}` : eventId, bucket: b?.label ?? marketId };
    };
    sim.orders = sim.orders.map((o) => ({ ...o, ...label(o.eventId, o.marketId) }));
    const skillRows = skill.globalTable().filter((r) => ["d0a", "d1", "d2"].includes(r.bin));
    return {
      updatedAt: new Date(nowMs).toISOString(),
      mode: { learning: learningOn, live: false },
      config: { bankrollUsd: cfg.sim.bankrollUsd, minEvents: cfg.learning.minEvents, models: cfg.models, ensembleModels: cfg.ensembleModels },
      status: {
        ...status,
        events: built.length,
        tradeable: built.filter((b) => b.ctx.tradeable).length,
        notTradeable: Object.entries(built.reduce((a, b) => {
          if (!b.ctx.tradeable) a[b.ctx.reason] = (a[b.ctx.reason] ?? 0) + 1;
          return a;
        }, {})),
        trackedAwaitingResolution: [...tracked.values()].filter((t) => {
          const st = registry.get(t.station);
          return st && nowMs >= localDayBounds(t.date, st.tz).endMs;
        }).length,
        forecastStations: [...forecasts.values()].filter((f) => f.detAt && nowMs - f.detAt < 3 * 3_600_000).length,
        ensembleStations: [...forecasts.values()].filter((f) => f.ensAt && f.ens).length,
        booksCached: books.size
      },
      sim,
      model: {
        calibrator: { weights: calibrator.weights(), updates: calibrator.updates(), scorecard: calibrator.scorecard() },
        mixer: mixer.table(),
        skill: skillRows,
        stationSkill: skill.stationTable("blend", "d1")
      },
      board
    };
  }

  // ---------------------------------------------------------------- main tick
  async function tick(nowMs = Date.now()) {
    checkControls();
    if (nowMs - timers.discover >= cfg.loop.discoverSec * 1000) {
      timers.discover = nowMs;
      try {
        await discover(nowMs);
      } catch (e) {
        err("discover", e);
      }
    }
    if (nowMs - timers.metar >= cfg.loop.metarSec * 1000) {
      timers.metar = nowMs;
      try {
        await pollObs(nowMs);
      } catch (e) {
        err("metar", e);
      }
    }
    try {
      await refreshForecasts(nowMs);
    } catch (e) {
      err("forecasts", e);
    }
    let built = buildAll(nowMs);
    try {
      if (await refreshBooks(built, nowMs)) built = buildAll(nowMs);
    } catch (e) {
      err("books", e);
    }
    engine.onTick(built.map((b) => b.ctx), nowMs);
    recordCheckpoints(built, nowMs);
    if (nowMs - timers.resolution >= 60_000) {
      timers.resolution = nowMs;
      await checkResolutions(nowMs);
    }
    maybeBackfill();
    lastBuilt = built;
    try {
      const tmp = `${files.dashboard}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(dashboard(built, nowMs)));
      fs.renameSync(tmp, files.dashboard);
    } catch (e) {
      err("dashboard", e);
    }
    if (nowMs - timers.save >= 5 * 60_000) {
      timers.save = nowMs;
      save();
    }
    if (nowMs - timers.summaryLog >= 5 * 60_000) {
      timers.summaryLog = nowMs;
      const s = engine.summary();
      log(`events=${built.length} tradeable=${built.filter((b) => b.ctx.tradeable).length} settled=${s.learning.settledEvents} `
        + `variants proven=${s.learning.variantsProven}/${s.learning.variantsTested} | `
        + s.strategies.map((x) => `${x.id} $${x.equity.toFixed(0)} (${x.openPositions}/${x.restingOrders})`).join(" "));
    }
    return built;
  }

  return { tick, save, load, engine, skill, calibrator, mixer, status, tracked, lastBuilt: () => lastBuilt };
}

async function main() {
  applyGlobalProxyFromEnv();
  const sim = createWeatherSim();
  if (sim.load()) console.log(`[weather] restored state from ${WCFG.logDir}`);
  console.log(`[weather] learning mode ${WCFG.learning.enabled ? "ON" : "OFF (frozen)"}; paper bankroll $${WCFG.sim.bankrollUsd} per strategy; tick ${WCFG.loop.tickSec}s`);
  const shutdown = () => {
    sim.save();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  for (;;) {
    const started = Date.now();
    try {
      await sim.tick(started);
    } catch (e) {
      console.error("[weather] tick error:", errorToRedactedLogString(e));
    }
    await sleep(Math.max(1000, WCFG.loop.tickSec * 1000 - (Date.now() - started)));
  }
}

const entryPath = process.env.pm_exec_path || process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((e) => {
    console.error("[weather] fatal:", errorToRedactedLogString(e));
    process.exit(1);
  });
}
