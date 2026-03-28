/**
 * Pure checks before placing a live Polymarket order.
 * Goal: avoid near–coin-flip entries and trades with no model-vs-market edge.
 */

export function meanAbsConfidenceSwing(history, nowMs, windowMs, baselineScore) {
  if (!Array.isArray(history) || !Number.isFinite(nowMs) || !Number.isFinite(windowMs)) return null;
  if (!Number.isFinite(Number(baselineScore))) return null;
  const start = nowMs - windowMs;
  const recent = history.filter((h) => Number.isFinite(Number(h.ts)) && h.ts >= start && h.ts <= nowMs);
  if (recent.length < 2) return null;
  const b = Number(baselineScore);
  let sum = 0;
  let n = 0;
  for (const h of recent) {
    if (!Number.isFinite(Number(h.score))) continue;
    sum += Math.abs(Number(h.score) - b);
    n += 1;
  }
  if (n < 2) return null;
  return sum / n;
}

/**
 * @param {object} p
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateLiveTradeGuards(p) {
  const {
    rec,
    edge,
    tradeSide,
    marketUp,
    marketDown,
    orderbook,
    liveMinModelEdge,
    coinFlipMinPrice,
    coinFlipMaxPrice,
    maxConfidenceSwingMeanAbs,
    confidenceHistory,
    nowMs,
    chopWindowMs,
    confidenceScore,
    requireEdgeAlignment = true,
    enforceCoinFlipGuard = true,
    enforceChopGuard = true
  } = p;

  if (!tradeSide || (tradeSide !== "UP" && tradeSide !== "DOWN")) {
    return { ok: false, reason: "invalid_trade_side" };
  }

  if (requireEdgeAlignment) {
    if (!rec || rec.action !== "ENTER" || rec.side !== tradeSide) {
      return { ok: false, reason: "edge_engine_no_enter_or_side_mismatch" };
    }

    const sideEdge = tradeSide === "UP" ? edge?.edgeUp : edge?.edgeDown;
    if (sideEdge === null || sideEdge === undefined || !Number.isFinite(Number(sideEdge))) {
      return { ok: false, reason: "missing_edge" };
    }
    if (Number(sideEdge) < liveMinModelEdge) {
      return { ok: false, reason: "model_market_edge_below_min" };
    }
  }

  const book = tradeSide === "UP" ? orderbook?.up : orderbook?.down;
  const bestAsk = book?.bestAsk != null && Number.isFinite(Number(book.bestAsk)) ? Number(book.bestAsk) : null;
  const fallback = tradeSide === "UP" ? marketUp : marketDown;
  const entryPrice = bestAsk ?? (fallback != null && Number.isFinite(Number(fallback)) ? Number(fallback) : null);

  if (entryPrice === null) {
    return { ok: false, reason: "missing_entry_price" };
  }

  if (enforceCoinFlipGuard) {
    if (entryPrice >= coinFlipMinPrice && entryPrice <= coinFlipMaxPrice) {
      return { ok: false, reason: "coin_flip_zone_price" };
    }
  }

  if (
    enforceChopGuard
    && maxConfidenceSwingMeanAbs > 0
    && Number.isFinite(Number(confidenceScore))
    && Array.isArray(confidenceHistory)
  ) {
    const swing = meanAbsConfidenceSwing(confidenceHistory, nowMs, chopWindowMs, confidenceScore);
    if (swing !== null && swing > maxConfidenceSwingMeanAbs) {
      return { ok: false, reason: "confidence_chop_high_swing" };
    }
  }

  return { ok: true };
}
