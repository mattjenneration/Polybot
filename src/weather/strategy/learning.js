/**
 * Learning-mode building blocks. All learn from settled events only, and every sample is one event (not one
 * bet) because buckets of the same event share an outcome.
 *
 *   createReturnStats  decay-weighted mean/variance of return per $ — used for strategy variants (what edge
 *                      threshold / timing / side / execution works), cities, and lead bins
 *   chooseVariant      Thompson sampling among variants whose lower confidence bound is above zero
 *   cityPolicy         stake multiplier per city: 0 (avoid) … 2 (favour), neutral while evidence builds
 *   createFillModel    P(a resting bid fills) by distance below the ask and phase — prices the "best bid"
 *   createExpertMixer  Bayesian-model-averaging weights (ensemble vs Gaussian) per lead bin from log scores
 */
import { mulberry32 } from "../../strategy/adaptive.js";
import { clamp, normCdf } from "../../core/math.js";

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function createReturnStats({ decay = 0.995 } = {}) {
  const stats = new Map(); // id → { w, mean, m2, n, stake, pnl }

  function record(id, ret, { stake = 0, pnl = 0 } = {}) {
    if (!Number.isFinite(ret)) return;
    const s = stats.get(id) ?? { w: 0, mean: 0, m2: 0, n: 0, stake: 0, pnl: 0 };
    s.w = decay * s.w + 1;
    s.m2 *= decay;
    const d = ret - s.mean;
    s.mean += d / s.w;
    s.m2 += d * (ret - s.mean);
    s.n += 1;
    s.stake += stake;
    s.pnl += pnl;
    stats.set(id, s);
  }

  function summary(id, { lcbZ = 1 } = {}) {
    const s = stats.get(id);
    if (!s) return { n: 0, effN: 0, mean: null, se: null, lcb: null, pPositive: 0.5, stake: 0, pnl: 0 };
    if (s.w <= 1.5) return { n: s.n, effN: s.w, mean: s.mean, se: null, lcb: null, pPositive: 0.5, stake: s.stake, pnl: s.pnl };
    const variance = Math.max(s.m2 / (s.w - 1), 1e-4);
    const se = Math.sqrt(variance / s.w);
    return { n: s.n, effN: s.w, mean: s.mean, se, lcb: s.mean - lcbZ * se, pPositive: normCdf(s.mean / se), stake: s.stake, pnl: s.pnl };
  }

  return {
    record,
    summary,
    ids: () => [...stats.keys()],
    toJSON: () => Object.fromEntries(stats),
    restore(st) {
      for (const [k, v] of Object.entries(st ?? {})) stats.set(k, { w: 0, mean: 0, m2: 0, n: 0, stake: 0, pnl: 0, ...v });
    }
  };
}

/** Thompson sampling over variants with a demonstrated edge (LCB > 0 after `minEvents`). */
export function createVariantChooser({ seed = 7 } = {}) {
  const rng = mulberry32(seed);
  return function chooseVariant(variants, stats, { minEvents, lcbZ, filter = () => true }) {
    let best = null;
    let bestDraw = -Infinity;
    for (const v of variants) {
      if (!filter(v)) continue;
      const s = stats.summary(v.id, { lcbZ });
      if (s.effN < minEvents || s.lcb === null || s.lcb <= 0) continue;
      const draw = s.mean + s.se * gaussian(rng);
      if (draw > bestDraw) {
        bestDraw = draw;
        best = { variant: v, summary: s };
      }
    }
    return best;
  };
}

/** Stake multiplier for a city from the pooled return of every bet the engine's variants placed there. */
export function cityPolicy(summary, { minEvents }) {
  if (!summary || summary.effN < minEvents || summary.se === null) return { mult: 1, status: "learning" };
  const p = summary.pPositive;
  if (p < 0.2) return { mult: 0, status: "avoid" };
  return { mult: clamp(2 * p, 0.25, 2), status: p >= 0.8 ? "favour" : p < 0.4 ? "reduce" : "neutral" };
}

export const DIST_BUCKETS = ["1c", "3c", "6c", "10c+"];
export const distBucket = (d) => (d <= 0.0101 ? "1c" : d <= 0.0301 ? "3c" : d <= 0.0601 ? "6c" : "10c+");
export const fillPhase = (bin) => (bin === "post" ? "post" : String(bin).startsWith("d0") ? "d0" : "early");
const FILL_PRIOR = { "1c": [2, 3], "3c": [1.5, 4.5], "6c": [1, 6], "10c+": [1, 10] };

/** Beta-Bernoulli fill rate for resting bids, keyed by distance below the ask × phase. */
export function createFillModel() {
  const counts = new Map(); // key → [fills, misses]
  const key = (dist, bin) => `${distBucket(dist)}|${fillPhase(bin)}`;
  function p(dist, bin) {
    const [a0, b0] = FILL_PRIOR[distBucket(dist)];
    const [f, m] = counts.get(key(dist, bin)) ?? [0, 0];
    return (a0 + f) / (a0 + b0 + f + m);
  }
  function record(dist, bin, filled) {
    const k = key(dist, bin);
    const c = counts.get(k) ?? [0, 0];
    c[filled ? 0 : 1] += 1;
    counts.set(k, c);
  }
  function table() {
    const rows = [];
    for (const phase of ["early", "d0", "post"]) {
      for (const d of DIST_BUCKETS) {
        const [f, m] = counts.get(`${d}|${phase}`) ?? [0, 0];
        const [a0, b0] = FILL_PRIOR[d];
        rows.push({ phase, dist: d, fills: f, misses: m, p: (a0 + f) / (a0 + b0 + f + m) });
      }
    }
    return rows;
  }
  return {
    p,
    record,
    table,
    toJSON: () => Object.fromEntries(counts),
    restore(st) {
      for (const [k, v] of Object.entries(st ?? {})) if (Array.isArray(v)) counts.set(k, v.map(Number));
    }
  };
}

/** Exponentially-weighted log-loss totals per expert per lead bin → softmax weights (Bayesian model averaging). */
export function createExpertMixer({ decay = 0.97, experts = ["gauss", "ens"] } = {}) {
  const loss = new Map(); // bin → { gauss, ens, n }
  function weights(bin) {
    const l = loss.get(bin);
    if (!l) return Object.fromEntries(experts.map((e) => [e, 1 / experts.length]));
    const m = Math.min(...experts.map((e) => l[e]));
    const raw = experts.map((e) => Math.exp(-(l[e] - m)));
    const z = raw.reduce((a, b) => a + b, 0);
    return Object.fromEntries(experts.map((e, i) => [e, clamp(raw[i] / z, 0.05, 0.95)]));
  }
  function record(bin, losses) {
    if (!experts.every((e) => Number.isFinite(losses[e]))) return;
    const l = loss.get(bin) ?? { ...Object.fromEntries(experts.map((e) => [e, 0])), n: 0 };
    for (const e of experts) l[e] = decay * l[e] + losses[e];
    l.n += 1;
    loss.set(bin, l);
  }
  return {
    weights,
    record,
    table: () => [...loss.entries()].map(([bin, l]) => ({ bin, n: l.n, ...weights(bin) })),
    toJSON: () => Object.fromEntries(loss),
    restore(st) {
      for (const [k, v] of Object.entries(st ?? {})) loss.set(k, v);
    }
  };
}
