import { clamp } from "../utils.js";

export function scoreOpenInterestIndicator({ openInterestDeltaPct, spotDelta3m }) {
  const name = "open_interest";
  const maxAbsScore = 16;

  if (!Number.isFinite(Number(openInterestDeltaPct))) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "OI unavailable"
    };
  }

  const oiDelta = Number(openInterestDeltaPct);
  const spot3m = Number.isFinite(Number(spotDelta3m)) ? Number(spotDelta3m) : 0;
  const sameDirection = (oiDelta > 0 && spot3m > 0) || (oiDelta < 0 && spot3m < 0);
  const oppositeDirection = (oiDelta > 0 && spot3m < 0) || (oiDelta < 0 && spot3m > 0);

  const intensity = clamp(Math.abs(oiDelta) / 0.01, 0, 1);
  /** Dampen when 3m spot move is tiny in USD (OI is 5m; noisy pairing with near-flat spot). */
  const spotSupport = clamp(Math.abs(spot3m) / 40, 0.2, 1);
  let score = 0;

  if (sameDirection && spot3m > 0) score = Math.round((5 + intensity * 11) * spotSupport);
  else if (sameDirection && spot3m < 0) score = -Math.round((5 + intensity * 11) * spotSupport);
  else if (oppositeDirection && spot3m > 0) score = -Math.round((3 + intensity * 8) * spotSupport);
  else if (oppositeDirection && spot3m < 0) score = Math.round((3 + intensity * 8) * spotSupport);

  score = clamp(score, -maxAbsScore, maxAbsScore);

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: oiDelta,
    summary: `OI ${oiDelta >= 0 ? "+" : ""}${(oiDelta * 100).toFixed(2)}%`
  };
}
