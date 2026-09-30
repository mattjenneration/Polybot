import { normCdf } from "./math.js";

/**
 * Probability that the round resolves UP (official final >= official price to beat) under a
 * driftless log-normal walk:
 *
 *   P(up) = Φ( ln(S / K) / sqrt(σ²τ + settleVar) )
 *
 * `settleVar` is the variance (in log terms) of the gap between the real-time Chainlink ticks we
 * observe and the reference prices Polymarket actually settles on, at both ends of the round.
 * Without it the model becomes wildly overconfident in the last ~20 seconds.
 *
 * @param {number} price        current Chainlink price S
 * @param {number} priceToBeat  latched start price K
 * @param {number} secondsLeft  τ
 * @param {number} sigma        volatility per sqrt(second)
 * @param {number} settleVar    extra log-variance from settlement reference noise
 */
export function fairProbUp({ price, priceToBeat, secondsLeft, sigma, settleVar = 0 }) {
  if (!(price > 0) || !(priceToBeat > 0) || !(sigma > 0)) return null;
  const x = Math.log(price / priceToBeat);
  const variance = sigma * sigma * Math.max(0, secondsLeft) + Math.max(0, settleVar);
  if (!(variance > 0)) {
    // Polymarket rules: Up wins ties ("greater than or equal to").
    return x >= 0 ? 1 : 0;
  }
  return normCdf(x / Math.sqrt(variance));
}
