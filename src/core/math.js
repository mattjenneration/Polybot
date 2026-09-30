export function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

export function isNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

const P_EPS = 1e-4;

export function logit(p) {
  const q = clamp(p, P_EPS, 1 - P_EPS);
  return Math.log(q / (1 - q));
}

export function sigmoid(x) {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

export function roundTo(x, decimals) {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

export function floorToTick(price, tick) {
  return roundTo(Math.floor((price + 1e-9) / tick) * tick, 6);
}
