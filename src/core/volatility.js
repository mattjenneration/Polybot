/**
 * EWMA realized volatility of log returns, sampled at >= 1s spacing.
 * Output is sigma per sqrt(second), so over τ seconds the stdev of ln(S_T/S_t) ≈ sigma * sqrt(τ).
 */

// ~50% annualized BTC vol expressed per sqrt(second); only used until enough samples arrive.
export const DEFAULT_SIGMA_PER_SQRT_SEC = 0.5 / Math.sqrt(365 * 24 * 3600);

export function createVolEstimator({ halfLifeSec = 600, minSpacingMs = 1000, maxGapMs = 30_000, warmupSamples = 60 } = {}) {
  let lastTs = null;
  let lastPrice = null;
  let variancePerSec = DEFAULT_SIGMA_PER_SQRT_SEC ** 2;
  let samples = 0;

  function observe(ts, price) {
    if (!Number.isFinite(ts) || !(price > 0)) return;
    if (lastTs === null) {
      lastTs = ts;
      lastPrice = price;
      return;
    }
    const dtMs = ts - lastTs;
    if (dtMs < minSpacingMs) return;
    if (dtMs > maxGapMs) {
      // Gap in the feed: restart the return chain instead of treating the jump as one return.
      lastTs = ts;
      lastPrice = price;
      return;
    }
    const dtSec = dtMs / 1000;
    const r = Math.log(price / lastPrice);
    const inst = (r * r) / dtSec;
    const alpha = 1 - Math.exp((-Math.LN2 * dtSec) / halfLifeSec);
    variancePerSec = variancePerSec + alpha * (inst - variancePerSec);
    samples += 1;
    lastTs = ts;
    lastPrice = price;
  }

  return {
    observe,
    sigma() {
      return Math.sqrt(Math.max(variancePerSec, 1e-14));
    },
    isWarm() {
      return samples >= warmupSamples;
    },
    samples() {
      return samples;
    },
    toJSON() {
      return { variancePerSec, samples };
    },
    restore(state) {
      if (state && Number.isFinite(state.variancePerSec) && state.variancePerSec > 0) {
        variancePerSec = state.variancePerSec;
        samples = Number(state.samples) || 0;
      }
    }
  };
}
