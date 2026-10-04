/**
 * One strategy's entry decision for one event: the best bucket side to buy now, at what price, and how much.
 *
 * Taker: edge = p − ask − fee(ask); limit = highest price that still clears minEdge (walks the book).
 * Maker: for each price below the ask, EV = P(fill | distance below ask, lead) × (p − price); post the argmax.
 * That's the "best bid": close to the ask fills often but earns little, deep bids earn more but rarely fill,
 * and the fill model learns where the balance sits from every resting order the sim places.
 */
import { takerFeePerShare } from "../../core/fees.js";
import { floorToTick, roundTo } from "../../core/math.js";
import { kellyFraction, maxTakerPrice } from "../../strategy/decide.js";

const MAKER_MAX_DEPTH = 0.15;

function bestMakerPrice({ pSide, bid, ask, tick, minEdge, band, fillP }) {
  let best = null;
  const top = Math.min(roundTo(ask - tick, 6), floorToTick(pSide - minEdge, tick), band[1]);
  const floor = Math.max(tick, band[0], roundTo(ask - MAKER_MAX_DEPTH, 6));
  for (let price = top; price >= floor - 1e-9; price = roundTo(price - tick, 6)) {
    const fp = fillP(ask - price);
    const ev = fp * (pSide - price);
    if (!best || ev > best.ev) best = { price, ev, fillP: fp, joinsQueue: bid !== null && price <= bid + 1e-9 };
    // A coarse 0.001 tick can mean 150 candidate levels; step faster once deep
    if (tick < 0.005 && ask - price > 0.02) price = roundTo(price - 4 * tick, 6);
  }
  return best;
}

/**
 * @param {object} strategy  preset, shadow variant, or the learning strategy merged with its chosen variant
 * @param {object} ectx      event context: { leadBin, buckets[{ marketId, tick, minSize, feeSchedule, yes, no }], probs }
 * @param {object} acct      { cash, equity, held:Set<marketId>, eventCount, eventExposure, openExposure }
 * @param {object} opts      { fillP(dist, bin), sizeMult, caps: { maxEventPct, maxOpenPct } }
 */
export function decideEvent(strategy, ectx, acct, { fillP = () => 0.2, sizeMult = 1, caps = {} } = {}) {
  if (!strategy.windows.includes(ectx.leadBin)) return { ok: false, reason: "outside_window" };
  if (acct.eventCount >= strategy.maxPerEvent) return { ok: false, reason: "max_per_event" };
  const probs = ectx.probs[strategy.probSource];
  if (!probs) return { ok: false, reason: `no_${strategy.probSource}_prob` };
  const pMkt = ectx.probs.market;
  const band = strategy.priceBand;

  let favIdx = -1;
  if (strategy.favoriteOnly) {
    if (!pMkt) return { ok: false, reason: "no_market_prob" };
    favIdx = pMkt.indexOf(Math.max(...pMkt));
  }

  let best = null;
  let lastReason = "no_edge";
  for (let i = 0; i < ectx.buckets.length; i += 1) {
    if (strategy.favoriteOnly && i !== favIdx) continue;
    const b = ectx.buckets[i];
    if (acct.held.has(b.marketId)) continue;
    for (const side of strategy.sides) {
      const pSide = side === "YES" ? probs[i] : 1 - probs[i];
      const pMarketSide = pMkt ? (side === "YES" ? pMkt[i] : 1 - pMkt[i]) : null;
      if (strategy.minProbSide && pSide < strategy.minProbSide) continue;
      if (strategy.maxGap !== undefined && pMarketSide !== null && Math.abs(pSide - pMarketSide) > strategy.maxGap) {
        lastReason = "model_market_gap";
        continue;
      }
      const book = side === "YES" ? b.yes : b.no;
      if (!book) {
        lastReason = "no_book";
        continue;
      }
      const ask = book.asks[0]?.[0] ?? null;
      if (ask === null) continue;

      if (strategy.execution === "maker") {
        const bid = book.bids[0]?.[0] ?? null;
        const m = bestMakerPrice({ pSide, bid, ask, tick: b.tick, minEdge: strategy.minEdge, band, fillP: (d) => fillP(d, ectx.leadBin) });
        if (!m || m.ev <= 0) continue;
        if (!best || m.ev > best.score) {
          best = {
            score: m.ev, bucketIdx: i, side, execution: "maker", price: m.price, refPrice: ask, costPerShare: m.price,
            pSide, pMarketSide, edge: pSide - m.price, fillP: m.fillP, dist: ask - m.price, joinsQueue: m.joinsQueue
          };
        }
        continue;
      }

      if (ask < band[0] || ask > band[1]) {
        lastReason = "price_band";
        continue;
      }
      const fee = takerFeePerShare(ask, b.feeSchedule);
      const edge = pSide - ask - fee;
      if (edge < strategy.minEdge) continue;
      const limit = strategy.minEdge < 0
        ? floorToTick(Math.min(band[1], ask + 2 * b.tick), b.tick)
        : maxTakerPrice(pSide, strategy.minEdge, b.feeSchedule, b.tick, band[1]);
      if (limit === null || limit < ask - 1e-9) continue;
      if (!best || edge > best.score) {
        best = { score: edge, bucketIdx: i, side, execution: "taker", limitPrice: limit, refPrice: ask, costPerShare: ask + fee, pSide, pMarketSide, edge };
      }
    }
  }
  if (!best) return { ok: false, reason: lastReason };

  const b = ectx.buckets[best.bucketIdx];
  const s = strategy.sizing;
  let stake;
  if (s.mode === "fixed") stake = s.usd;
  else {
    const f = kellyFraction(best.pSide, best.costPerShare);
    if (f <= 0) return { ok: false, reason: "kelly_non_positive" };
    if (!(sizeMult > 0)) return { ok: false, reason: "zero_size_multiplier" };
    const room = Math.min(
      caps.maxEventPct ? acct.equity * caps.maxEventPct - acct.eventExposure : Infinity,
      caps.maxOpenPct ? acct.equity * caps.maxOpenPct - acct.openExposure : Infinity
    );
    stake = Math.min(acct.equity * s.fraction * f * sizeMult, acct.equity * s.maxPct, s.maxUsd, room);
    if (!(stake > 0)) return { ok: false, reason: "exposure_cap" };
    const minStake = b.minSize * best.costPerShare;
    if (stake < minStake) {
      // Round up to the exchange minimum only while it stays inside every cap
      if (minStake > s.maxUsd || minStake > room) return { ok: false, reason: "below_min_order_size" };
      stake = minStake;
    }
  }
  if (!(stake > 0)) return { ok: false, reason: "exposure_cap" };
  if (stake > acct.cash) return { ok: false, reason: "insufficient_bankroll" };
  return { ok: true, order: { ...best, marketId: b.marketId, stakeUsd: roundTo(stake, 4) } };
}
