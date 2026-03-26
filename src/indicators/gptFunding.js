import { clamp } from "../utils.js";

export function scoreFundingIndicator({ fundingRate }) {
  const name = "funding";
  const maxAbsScore = 14;

  if (!Number.isFinite(Number(fundingRate))) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "Funding unavailable"
    };
  }

  const fr = Number(fundingRate);
  const extreme = clamp(Math.abs(fr) / 0.0006, 0, 1);

  let score = 0;
  if (fr > 0) {
    score = -Math.round(4 + extreme * 10);
  } else if (fr < 0) {
    score = Math.round(4 + extreme * 10);
  }

  score = clamp(score, -maxAbsScore, maxAbsScore);

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: fr,
    summary: `Funding ${(fr * 10_000).toFixed(2)} bps`
  };
}
