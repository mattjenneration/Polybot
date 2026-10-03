/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7). */
export function normCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export const MS_PER_YEAR = 365 * 24 * 3600 * 1000;

export function clampProb(p) {
  if (!Number.isFinite(p)) return null;
  return Math.max(0, Math.min(1, p));
}

/** Risk-neutral (zero-drift) lognormal P(S_T > K). `sigma` annualized, `tYears` > 0. */
export function probAbove({ spot, strike, sigma, tYears }) {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (!(tYears > 0) || !(sigma > 0)) return spot > strike ? 1 : 0;
  const sd = sigma * Math.sqrt(tYears);
  const d2 = (Math.log(spot / strike) - 0.5 * sd * sd) / sd;
  return normCdf(d2);
}

/**
 * Probability the price touches `barrier` before expiry (continuous monitoring, driftless log-price):
 * P = 2 · N(−|ln(B/S)| / (σ√T)). Already through the barrier → 1.
 */
export function probTouch({ spot, barrier, sigma, tYears }) {
  if (!(spot > 0) || !(barrier > 0)) return null;
  const dist = Math.abs(Math.log(barrier / spot));
  if (dist === 0) return 1;
  if (!(tYears > 0) || !(sigma > 0)) return 0;
  return clampProb(2 * normCdf(-dist / (sigma * Math.sqrt(tYears))));
}

/** Annualized realized vol from a series of closes sampled every `intervalMs`. */
export function realizedVol(closes, intervalMs) {
  const xs = (closes || []).filter((x) => Number.isFinite(x) && x > 0);
  if (xs.length < 10) return null;
  const rets = [];
  for (let i = 1; i < xs.length; i += 1) rets.push(Math.log(xs[i] / xs[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * (MS_PER_YEAR / intervalMs));
}
