import { takerFeePerShare, takerFeeUsd } from "./fees.js";
import { roundTo } from "./math.js";

/**
 * Normalize a CLOB /book response (or a recorded compact book) into
 * { bids: [[price, size], ...] best-first, asks: [[price, size], ...] best-first }.
 * The CLOB REST API lists levels worst-first, so always sort explicitly.
 */
export function normalizeBook(raw, depth = 10) {
  const toLevels = (levels) =>
    (Array.isArray(levels) ? levels : [])
      .map((l) => (Array.isArray(l) ? [Number(l[0]), Number(l[1])] : [Number(l?.price), Number(l?.size)]))
      .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s) && p > 0 && p < 1 && s > 0);

  const bids = toLevels(raw?.bids).sort((a, b) => b[0] - a[0]).slice(0, depth);
  const asks = toLevels(raw?.asks).sort((a, b) => a[0] - b[0]).slice(0, depth);
  return { bids, asks };
}

export function bestBid(book) {
  return book?.bids?.length ? book.bids[0][0] : null;
}

export function bestAsk(book) {
  return book?.asks?.length ? book.asks[0][0] : null;
}

export function midPrice(book) {
  const b = bestBid(book);
  const a = bestAsk(book);
  if (b !== null && a !== null) return (a + b) / 2;
  return a ?? b ?? null;
}

/** Sum of size on the first `levels` levels of a side. */
export function depthShares(levels, n = 5) {
  return (levels ?? []).slice(0, n).reduce((acc, [, s]) => acc + s, 0);
}

/**
 * Simulate a marketable BUY that walks the ask ladder up to `limitPrice`,
 * spending at most `maxUsd` (price + taker fee included).
 * Returns null if nothing fills.
 */
export function simulateTakerBuy(book, { maxUsd, limitPrice, feeSchedule }) {
  const asks = book?.asks ?? [];
  let remainingUsd = maxUsd;
  let shares = 0;
  let notional = 0;
  let fee = 0;
  for (const [price, size] of asks) {
    if (price > limitPrice + 1e-9 || remainingUsd <= 1e-9) break;
    const perShare = price + takerFeePerShare(price, feeSchedule);
    const take = Math.min(size, remainingUsd / perShare);
    if (take <= 0) break;
    shares += take;
    notional += take * price;
    fee += takerFeeUsd(take, price, feeSchedule);
    remainingUsd -= take * perShare;
  }
  if (shares <= 1e-9) return null;
  return {
    shares: roundTo(shares, 6),
    notionalUsd: roundTo(notional, 6),
    feeUsd: roundTo(fee, 6),
    costUsd: roundTo(notional + fee, 6),
    avgPrice: notional / shares
  };
}
