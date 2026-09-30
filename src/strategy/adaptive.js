/**
 * Adaptive strategy selector.
 *
 * Every shadow variant is paper-traded with a $1 stake. Each settled shadow bet reports its
 * return per dollar; we keep an exponentially-decayed mean/variance per variant, so recent
 * performance counts more and the selector drifts as market behaviour changes.
 *
 * Each round, Thompson sampling picks among variants whose lower confidence bound on mean
 * return is above zero — i.e. variants that have *demonstrated* an edge. If none qualify the
 * adaptive strategy sits the round out.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function createAdaptiveSelector({ decay = 0.999, minSamples = 40, lcbZ = 1.0, seed = 42 } = {}) {
  const stats = new Map(); // variantId -> { w, mean, m2, n }
  const rng = mulberry32(seed);

  function record(variantId, returnPerDollar) {
    if (!Number.isFinite(returnPerDollar)) return;
    const s = stats.get(variantId) ?? { w: 0, mean: 0, m2: 0, n: 0 };
    s.w = decay * s.w + 1;
    s.m2 *= decay;
    const delta = returnPerDollar - s.mean;
    s.mean += delta / s.w;
    s.m2 += delta * (returnPerDollar - s.mean);
    s.n += 1;
    stats.set(variantId, s);
  }

  function summary(variantId) {
    const s = stats.get(variantId);
    if (!s || s.w <= 1) return { n: s?.n ?? 0, effN: s?.w ?? 0, mean: s?.mean ?? null, se: null, lcb: null };
    const variance = Math.max(s.m2 / (s.w - 1), 1e-6);
    const se = Math.sqrt(variance / s.w);
    return { n: s.n, effN: s.w, mean: s.mean, se, lcb: s.mean - lcbZ * se };
  }

  /** @param {object[]} variants  @returns {object|null} chosen variant */
  function choose(variants) {
    let best = null;
    let bestDraw = -Infinity;
    for (const v of variants) {
      const sm = summary(v.id);
      if (sm.effN < minSamples || sm.lcb === null || sm.lcb <= 0) continue;
      const draw = sm.mean + sm.se * gaussian(rng);
      if (draw > bestDraw) {
        bestDraw = draw;
        best = v;
      }
    }
    return best;
  }

  function leaderboard(variants, limit = 8) {
    return variants
      .map((v) => ({ id: v.id, label: v.label, ...summary(v.id) }))
      .filter((r) => r.n > 0)
      .sort((a, b) => (b.lcb ?? -Infinity) - (a.lcb ?? -Infinity))
      .slice(0, limit);
  }

  return {
    record,
    choose,
    summary,
    leaderboard,
    toJSON() {
      return { stats: Object.fromEntries(stats) };
    },
    restore(state) {
      if (!state?.stats) return;
      for (const [k, v] of Object.entries(state.stats)) stats.set(k, { w: 0, mean: 0, m2: 0, n: 0, ...v });
    }
  };
}
