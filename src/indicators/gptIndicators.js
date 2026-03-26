import { clamp } from "../utils.js";
import { scoreFundingIndicator } from "./gptFunding.js";
import { scoreOpenInterestIndicator } from "./gptOpenInterest.js";
import { scoreLongShortIndicator } from "./gptLongShort.js";
import { scoreBasisIndicator } from "./gptBasis.js";
import { scorePolymarketMicroIndicator } from "./gptPolymarketMicro.js";

/**
 * Futures + orderbook microstructure only (no duplicate spot-vs-Polymarket edge;
 * that lives in generateConfidenceScore TA block).
 */
export function evaluateGptIndicators({ futuresSnapshot, polymarketSnapshot, spotDelta1m, spotDelta3m }) {
  const signals = [
    scoreFundingIndicator({ fundingRate: futuresSnapshot?.fundingRate ?? null }),
    scoreOpenInterestIndicator({
      openInterestDeltaPct: futuresSnapshot?.openInterestDeltaPct ?? null,
      spotDelta3m
    }),
    scoreLongShortIndicator({
      longShortRatio: futuresSnapshot?.longShortRatio ?? null,
      longShortDelta: futuresSnapshot?.longShortDelta ?? null
    }),
    scoreBasisIndicator({ basisPct: futuresSnapshot?.basisPct ?? null }),
    scorePolymarketMicroIndicator({ polymarketSnapshot })
  ];

  const totalScore = signals.reduce((acc, x) => acc + x.score, 0);
  const totalAbsMax = signals.reduce((acc, x) => acc + x.maxAbsScore, 0);
  const normalized = totalAbsMax > 0 ? clamp((totalScore / totalAbsMax) * 100, -100, 100) : 0;

  return {
    score: normalized,
    direction: normalized > 0 ? "UP" : normalized < 0 ? "DOWN" : "FLAT",
    confidence: Math.round(Math.abs(normalized)),
    indicators: signals,
    byName: Object.fromEntries(signals.map((x) => [x.name, x]))
  };
}
