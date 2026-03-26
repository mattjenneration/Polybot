import { clamp } from "../utils.js";

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Orderbook microstructure only: bid depth imbalance and relative spread tightness.
 * Does not re-score market-implied probabilities (avoids double-counting TA + noise).
 */
export function scorePolymarketMicroIndicator({ polymarketSnapshot }) {
  const name = "polymarket_micro";
  const maxAbsScore = 10;

  if (!polymarketSnapshot?.ok) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "Polymarket snapshot unavailable"
    };
  }

  const upBidLiq = safeNumber(polymarketSnapshot.orderbook?.up?.bidLiquidity);
  const downBidLiq = safeNumber(polymarketSnapshot.orderbook?.down?.bidLiquidity);
  const upSpread = safeNumber(polymarketSnapshot.orderbook?.up?.spread);
  const downSpread = safeNumber(polymarketSnapshot.orderbook?.down?.spread);

  let score = 0;

  if (upBidLiq !== null && downBidLiq !== null && upBidLiq + downBidLiq > 0) {
    const ratio = (upBidLiq + 1) / (downBidLiq + 1);
    const balance = clamp((ratio - 1) / 0.65, -1, 1);
    score += Math.round(balance * 5);
  }

  if (upSpread !== null && downSpread !== null && upSpread > 0 && downSpread > 0) {
    if (upSpread < downSpread * 0.78) score += 3;
    else if (downSpread < upSpread * 0.78) score -= 3;
  }

  score = clamp(score, -maxAbsScore, maxAbsScore);

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: score,
    summary: `OB micro ${score >= 0 ? "+" : ""}${score}`
  };
}
