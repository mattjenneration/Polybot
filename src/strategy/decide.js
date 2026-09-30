import { takerFeePerShare } from "../core/fees.js";
import { bestAsk, bestBid } from "../core/orderbook.js";
import { floorToTick, roundTo } from "../core/math.js";

const SIDES = ["UP", "DOWN"];

/** Highest tick price p at which buying still clears `minEdge` after the taker fee. */
export function maxTakerPrice(pSide, minEdge, feeSchedule, tick, cap) {
  let p = floorToTick(Math.min(cap, 0.99), tick);
  while (p >= tick) {
    if (pSide - p - takerFeePerShare(p, feeSchedule) >= minEdge) return p;
    p = roundTo(p - tick, 6);
  }
  return null;
}

/** Fraction of bankroll suggested by Kelly for a binary share costing `cost` that pays $1 with prob `p`. */
export function kellyFraction(p, cost) {
  if (!(cost > 0) || !(cost < 1)) return 0;
  return (p - cost) / (1 - cost);
}

function sizeStake(strategy, { pSide, costPerShare, cash, minOrderSize }) {
  const s = strategy.sizing;
  let stake;
  let cap;
  if (s.mode === "fixed") {
    stake = s.usd;
    cap = s.usd;
  } else {
    const f = kellyFraction(pSide, costPerShare);
    if (f <= 0) return { ok: false, reason: "kelly_non_positive" };
    cap = Math.min(cash * s.maxPctBankroll, s.maxUsd);
    stake = Math.min(cash * s.fraction * f, cap);
  }
  if (!strategy.shadow && minOrderSize > 0) {
    const minStake = minOrderSize * costPerShare;
    if (stake < minStake) {
      // Allow rounding up to the exchange minimum only when it stays within the strategy's hard caps.
      const hardCap = s.mode === "fixed" ? Math.max(s.usd, minStake) : Math.min(s.maxUsd, cash * s.maxPctBankroll * 2);
      if (minStake > hardCap) return { ok: false, reason: "below_min_order_size" };
      stake = minStake;
    }
  }
  if (stake > cash) return { ok: false, reason: "insufficient_bankroll" };
  if (!(stake > 0)) return { ok: false, reason: "zero_stake" };
  return { ok: true, stakeUsd: roundTo(stake, 4) };
}

/**
 * @param {object} strategy   preset from strategies.js (for adaptive: the chosen variant merged with adaptive sizing)
 * @param {object} ctx        decision context from buildContext()
 * @param {{ cash: number }} account
 * @param {{ side: string|null, bets: number, lastBetTs: number|null }} roundPos
 */
export function decideEntry(strategy, ctx, account, roundPos) {
  if (!ctx.tradeable) return { ok: false, reason: ctx.notTradeableReason ?? "not_tradeable" };

  const [minSec, maxSec] = strategy.windowSec;
  if (ctx.secondsLeft < minSec || ctx.secondsLeft > maxSec) return { ok: false, reason: "outside_window" };

  if (roundPos.bets >= strategy.maxBetsPerRound) return { ok: false, reason: "max_bets_this_round" };
  if (roundPos.lastBetTs !== null && ctx.ts - roundPos.lastBetTs < strategy.minSecondsBetweenBets * 1000) {
    return { ok: false, reason: "spacing" };
  }

  const pUp = ctx.probs[strategy.probSource];
  if (pUp === null || pUp === undefined) return { ok: false, reason: `no_${strategy.probSource}_prob` };
  if (ctx.probs.market !== null && Math.abs(pUp - ctx.probs.market) > strategy.maxModelMarketGap) {
    return { ok: false, reason: "model_market_gap_too_large" };
  }

  const tick = ctx.tickSize;
  let best = null;
  for (const side of SIDES) {
    if (roundPos.side && roundPos.side !== side) continue;
    const pSide = side === "UP" ? pUp : 1 - pUp;
    if (strategy.probSource === "market" && pSide < 0.5) continue;
    const book = ctx.books[side];
    const ask = bestAsk(book);

    if (strategy.execution === "maker") {
      const bid = bestBid(book);
      if (bid === null || ask === null) continue;
      const target = floorToTick(pSide - strategy.minEdge, tick);
      const price = roundTo(Math.min(bid + tick, target), 6);
      if (!(price >= tick) || price >= ask) continue;
      if (price < strategy.priceBand[0] || price > strategy.priceBand[1]) continue;
      const edge = pSide - price;
      if (edge < strategy.minEdge) continue;
      if (!best || edge > best.edgePerShare) {
        best = { side, pSide, refPrice: price, limitPrice: price, costPerShare: price, edgePerShare: edge, joinsQueue: price <= bid };
      }
      continue;
    }

    if (ask === null) continue;
    if (ask < strategy.priceBand[0] || ask > strategy.priceBand[1]) continue;
    const fee = takerFeePerShare(ask, ctx.feeSchedule);
    const edge = pSide - ask - fee;
    if (edge < strategy.minEdge) continue;
    const cap = strategy.probSource === "market" ? Math.min(strategy.priceBand[1], ask + 2 * tick) : strategy.priceBand[1];
    const limitPrice = strategy.minEdge < 0 ? floorToTick(cap, tick) : maxTakerPrice(pSide, strategy.minEdge, ctx.feeSchedule, tick, cap);
    if (limitPrice === null || limitPrice < ask) continue;
    if (!best || edge > best.edgePerShare) {
      best = { side, pSide, refPrice: ask, limitPrice, costPerShare: ask + fee, edgePerShare: edge };
    }
  }

  if (!best) return { ok: false, reason: "no_edge" };

  const size = sizeStake(strategy, {
    pSide: best.pSide,
    costPerShare: best.costPerShare,
    cash: account.cash,
    minOrderSize: ctx.minOrderSize
  });
  if (!size.ok) return { ok: false, reason: size.reason };

  return {
    ok: true,
    execution: strategy.execution,
    side: best.side,
    pSide: best.pSide,
    pMarketSide: ctx.probs.market === null ? null : best.side === "UP" ? ctx.probs.market : 1 - ctx.probs.market,
    refPrice: best.refPrice,
    limitPrice: best.limitPrice,
    edgePerShare: best.edgePerShare,
    joinsQueue: Boolean(best.joinsQueue),
    stakeUsd: size.stakeUsd
  };
}
