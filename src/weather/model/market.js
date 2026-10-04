/**
 * What the market is saying about an event: implied bucket distribution (normalized mids), quote quality and
 * overround. Uses full CLOB books where fresh, else Gamma's top of book. NO books are the mirror of YES books
 * on Polymarket (NO ask = 1 − YES bid), so only YES books are ever fetched.
 */
import { distSummary } from "./distribution.js";

/** Derived NO book from a YES book (both as [[price, size]] best-first). */
export function mirrorBook(yes) {
  return {
    bids: (yes?.asks ?? []).map(([p, s]) => [Number((1 - p).toFixed(6)), s]),
    asks: (yes?.bids ?? []).map(([p, s]) => [Number((1 - p).toFixed(6)), s])
  };
}

export function marketView(event, books, nowMs, maxAgeMs) {
  const rows = event.buckets.map((b) => {
    const book = books.get(b.yesTokenId);
    const fresh = Boolean(book && nowMs - book.rx <= maxAgeMs);
    const bid = fresh ? book.bids[0]?.[0] ?? null : b.bestBid;
    const ask = fresh ? book.asks[0]?.[0] ?? null : b.bestAsk;
    let mid = null;
    if (bid !== null && ask !== null && ask >= bid) mid = (bid + ask) / 2;
    else if (ask !== null) mid = ask / 2;
    else if (bid !== null) mid = (bid + 1) / 2;
    return { bid, ask, mid, spread: bid !== null && ask !== null ? ask - bid : null, fresh };
  });
  const sum = rows.reduce((a, r) => a + (r.mid ?? 0.001), 0);
  const twoSided = rows.filter((r) => r.spread !== null && r.spread <= 0.15).length;
  // Mids that roughly sum to 1 carry information even when spreads are wide (thin low-temperature markets)
  const ok = sum > 0.6 && sum < 1.5 && rows.some((r) => r.bid !== null);
  const pMkt = ok ? rows.map((r) => Math.max(0.0005, (r.mid ?? 0.001) / sum)) : null;
  const asks = rows.reduce((a, r) => a + (r.ask ?? 1), 0);
  return {
    rows,
    pMkt: pMkt ? pMkt.map((p) => p / pMkt.reduce((a, b) => a + b, 0)) : null,
    quality: ok ? (twoSided >= 2 ? "good" : twoSided === 1 ? "thin" : "wide") : "none",
    overround: asks - 1,
    implied: pMkt ? distSummary(event.buckets, pMkt) : null
  };
}
