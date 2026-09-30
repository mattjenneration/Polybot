import { roundTo } from "./math.js";

/**
 * Polymarket crypto fee schedule (Gamma `market.feeSchedule`, "crypto_fees_v2"):
 *   fee (USDC) = shares × rate × (p × (1 − p)) ^ exponent
 * charged to takers only; makers pay nothing and earn `rebateRate` of fees as a rebate.
 */
export const DEFAULT_FEE_SCHEDULE = Object.freeze({ rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 });

export function normalizeFeeSchedule(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") return { ...DEFAULT_FEE_SCHEDULE };
  const rate = Number(obj.rate);
  const exponent = Number(obj.exponent);
  return {
    rate: Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_FEE_SCHEDULE.rate,
    exponent: Number.isFinite(exponent) && exponent > 0 ? exponent : DEFAULT_FEE_SCHEDULE.exponent,
    takerOnly: obj.takerOnly !== false,
    rebateRate: Number.isFinite(Number(obj.rebateRate)) ? Number(obj.rebateRate) : DEFAULT_FEE_SCHEDULE.rebateRate
  };
}

export function takerFeeUsd(shares, price, schedule = DEFAULT_FEE_SCHEDULE) {
  if (!(shares > 0) || !(price > 0) || !(price < 1)) return 0;
  const fee = shares * schedule.rate * (price * (1 - price)) ** schedule.exponent;
  return roundTo(fee, 5);
}

/** Fee per share at a given price, for edge calculations. */
export function takerFeePerShare(price, schedule = DEFAULT_FEE_SCHEDULE) {
  if (!(price > 0) || !(price < 1)) return 0;
  return schedule.rate * (price * (1 - price)) ** schedule.exponent;
}
