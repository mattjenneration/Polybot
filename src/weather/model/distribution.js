/**
 * Distribution of a day's temperature extreme X and its bucket probabilities.
 *
 *   high: X = max(observed so far, R)    low: X = min(observed so far, R)
 *
 * where R is the extreme over the rest of the local day. Observations are a hard floor (high) or ceiling (low):
 * once 70°F has been reported, every bucket below it is impossible.
 */
import { normCdf } from "../../core/math.js";

/** Range of continuous X that resolves into bucket [lo, hi]: rounding (METAR) or 0.1° truncation (HKO). */
export function bucketInterval(b, rule) {
  if (rule === "floor") return [b.lo === null ? -Infinity : b.lo - 0.05, b.hi === null ? Infinity : b.hi + 0.95];
  return [b.lo === null ? -Infinity : b.lo - 0.5, b.hi === null ? Infinity : b.hi + 0.5];
}

/** Bucket a reported value resolves to (index), or -1. */
export function bucketIndexForValue(buckets, value, rule) {
  return buckets.findIndex((b) => {
    const [a, z] = bucketInterval(b, rule);
    return value >= a && value < z;
  });
}

// Fat-tailed normal: 85% N(μ, s) + 15% N(μ, 2s), scaled so the overall sd is `sd`. Busts (fronts, sea breezes,
// convection) happen more often than a plain normal allows, and long-shot buckets are priced off the tails.
const TAIL_W = 0.15;
const CORE_SCALE = 1 / Math.sqrt(1 - TAIL_W + 4 * TAIL_W);

export function tailNormCdf(x, mu, sd) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const s = Math.max(1e-6, sd * CORE_SCALE);
  return (1 - TAIL_W) * normCdf((x - mu) / s) + TAIL_W * normCdf((x - mu) / (2 * s));
}

export function gaussianCdf(mu, sd) {
  return (x) => tailNormCdf(x, mu, sd);
}

/** Kernel-dressed ensemble: each (debiased) member smeared by N(0, h). */
export function ensembleCdf(members, h) {
  const n = members.length;
  return (x) => {
    if (x === Infinity) return 1;
    if (x === -Infinity) return 0;
    let s = 0;
    for (const m of members) s += normCdf((x - m) / h);
    return s / n;
  };
}

/** P(X < x) for the day's extreme given the observed extreme so far and the remaining-period CDF. */
export function dayExtremeCdf(kind, obsExt, remCdf) {
  if (obsExt === null || obsExt === undefined || !Number.isFinite(obsExt)) return remCdf;
  if (kind === "high") return (x) => (x <= obsExt ? 0 : remCdf(x));
  return (x) => (x > obsExt ? 1 : remCdf(x));
}

/** Bucket probabilities under `cdf`, normalized to sum to 1. */
export function bucketProbs(buckets, cdf, rule) {
  const ps = buckets.map((b) => {
    const [a, z] = bucketInterval(b, rule);
    return Math.max(0, cdf(z) - cdf(a));
  });
  const total = ps.reduce((x, y) => x + y, 0);
  return total > 0 ? ps.map((p) => p / total) : ps.map(() => 1 / buckets.length);
}

/** Buckets that observations already rule out. */
export function impossibleBuckets(buckets, kind, obsExt, rule) {
  return buckets.map((b) => {
    if (obsExt === null || obsExt === undefined || !Number.isFinite(obsExt)) return false;
    const [a, z] = bucketInterval(b, rule);
    return kind === "high" ? z <= obsExt : a > obsExt;
  });
}

/** Representative temperature for a bucket (open ends extend one degree). */
export function bucketCenter(b) {
  if (b.lo === null) return b.hi - 1;
  if (b.hi === null) return b.lo + 1;
  return (b.lo + b.hi) / 2;
}

/** Mean and sd of a bucket distribution. */
export function distSummary(buckets, ps) {
  let mean = 0;
  for (let i = 0; i < buckets.length; i += 1) mean += ps[i] * bucketCenter(buckets[i]);
  let v = 0;
  for (let i = 0; i < buckets.length; i += 1) v += ps[i] * (bucketCenter(buckets[i]) - mean) ** 2;
  return { mean, sd: Math.sqrt(v) };
}

/** Categorical log loss of the winning bucket (probabilities floored so one miss can't dominate). */
export function logLoss(ps, winnerIdx, floor = 1e-3) {
  return -Math.log(Math.max(floor, ps[winnerIdx] ?? 0));
}

/** Multi-category Brier score. */
export function brier(ps, winnerIdx) {
  let s = 0;
  for (let i = 0; i < ps.length; i += 1) s += (ps[i] - (i === winnerIdx ? 1 : 0)) ** 2;
  return s;
}
