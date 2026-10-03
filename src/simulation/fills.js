/**
 * Realistic paper fills against a Polymarket CLOB order book, with taker fees.
 *
 * Fee model (Polymarket 2026 per-category taker fees):
 *   fee = shares × p × feeRate × (p × (1 − p))^exponent
 * At p = 0.50 with exponent 0.5 this gives $1.80 / 100 shares for crypto (feeRate 0.072)
 * and $1.25 / 100 shares for weather (feeRate 0.05). Makers pay no fee.
 * Rates change over time — override per category with FEE_RATE_<CATEGORY> / FEE_EXPONENT_<CATEGORY>.
 */

const DEFAULT_FEE_SCHEDULES = {
  crypto: { feeRate: 0.072, exponent: 0.5 },
  weather: { feeRate: 0.05, exponent: 0.5 },
  economics: { feeRate: 0.05, exponent: 0.5 },
  sports: { feeRate: 0.03, exponent: 0.5 },
  none: { feeRate: 0, exponent: 1 }
};

function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function getFeeSchedule(category) {
  const key = String(category || "none").toLowerCase();
  const base = DEFAULT_FEE_SCHEDULES[key] ?? DEFAULT_FEE_SCHEDULES.none;
  const upper = key.toUpperCase();
  const feeRate = envNumber(`FEE_RATE_${upper}`);
  const exponent = envNumber(`FEE_EXPONENT_${upper}`);
  return {
    category: key,
    feeRate: feeRate ?? base.feeRate,
    exponent: exponent ?? base.exponent
  };
}

/** Taker fee in USDC for buying `shares` at `price`. */
export function takerFeeUsd({ shares, price, schedule }) {
  const p = Number(price);
  const c = Number(shares);
  if (!schedule || !Number.isFinite(p) || !Number.isFinite(c) || c <= 0 || p <= 0 || p >= 1) return 0;
  return c * p * schedule.feeRate * Math.pow(p * (1 - p), schedule.exponent);
}

/** All-in cost per share (price + fee) when taking at `price`. */
export function allInPricePerShare(price, schedule) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return p + takerFeeUsd({ shares: 1, price: p, schedule });
}

/** Normalize CLOB `asks` ([{price, size}] as strings, any order) to ascending numeric levels. */
export function normalizeAskLevels(asks) {
  return (Array.isArray(asks) ? asks : [])
    .map((lvl) => ({ price: Number(lvl?.price), size: Number(lvl?.size) }))
    .filter((lvl) => Number.isFinite(lvl.price) && Number.isFinite(lvl.size) && lvl.price > 0 && lvl.price < 1 && lvl.size > 0)
    .sort((a, b) => a.price - b.price);
}

/**
 * Simulate a FAK taker buy: walk asks from best price up to `maxPrice`, spending at most `budgetUsd`
 * including fees. Returns status "filled" | "partial" | "ask_above_max" | "no_liquidity".
 */
export function simulateTakerBuy({ asks, budgetUsd, maxPrice = 0.99, feeSchedule }) {
  const levels = normalizeAskLevels(asks);
  const empty = {
    shares: 0,
    costUsd: 0,
    feeUsd: 0,
    totalUsd: 0,
    avgPrice: null,
    bestAsk: levels.length ? levels[0].price : null,
    worstPrice: null,
    levelsUsed: 0
  };
  const budget = Number(budgetUsd);
  if (!levels.length) return { status: "no_liquidity", ...empty };
  if (!Number.isFinite(budget) || budget <= 0) return { status: "no_liquidity", ...empty };
  if (levels[0].price > maxPrice) return { status: "ask_above_max", ...empty };

  let remaining = budget;
  let shares = 0;
  let costUsd = 0;
  let feeUsd = 0;
  let worstPrice = null;
  let levelsUsed = 0;

  for (const lvl of levels) {
    if (lvl.price > maxPrice || remaining <= 1e-9) break;
    const perShare = allInPricePerShare(lvl.price, feeSchedule);
    const take = Math.min(lvl.size, remaining / perShare);
    if (take <= 1e-9) break;
    const cost = take * lvl.price;
    const fee = takerFeeUsd({ shares: take, price: lvl.price, schedule: feeSchedule });
    shares += take;
    costUsd += cost;
    feeUsd += fee;
    remaining -= cost + fee;
    worstPrice = lvl.price;
    levelsUsed += 1;
  }

  if (shares <= 0) return { status: "no_liquidity", ...empty };
  const totalUsd = costUsd + feeUsd;
  return {
    status: totalUsd >= budget - 1e-6 ? "filled" : "partial",
    shares,
    costUsd,
    feeUsd,
    totalUsd,
    avgPrice: costUsd / shares,
    bestAsk: levels[0].price,
    worstPrice,
    levelsUsed
  };
}

/** P&L of a held binary position at resolution. Winning shares pay $1 each. */
export function settleBinaryPosition({ shares, totalUsd, won }) {
  const payout = won ? Number(shares) : 0;
  return { payoutUsd: payout, pnlUsd: payout - Number(totalUsd) };
}
