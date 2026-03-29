import { clamp } from "../utils.js";

/**
 * Auxiliary signal from rolling Polymarket Up/Down best-bid swings only (no spot).
 * High lead-flip churn → dampen conviction; stable skew → mild directional nudge.
 */
export function scorePolySwingsIndicator({ polySwingsContext }) {
  const name = "polyswings";
  const maxAbsScore = 10;
  const ctx = polySwingsContext;

  if (!ctx?.hasData) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "PolySwings warming up (10s bids, 1h window)"
    };
  }

  const n = Math.max(1, ctx.sampleCount);
  const flips = ctx.leadFlips ?? 0;
  const flipRate = flips / n;
  const churn = clamp(flipRate / 0.35, 0, 1);
  const skew = (ctx.upLeaderFrac ?? 0.5) - 0.5;
  const calm = 1 - churn;
  const raw = calm * 2 * skew * 10;
  let score = Math.round(raw);
  score = clamp(score, -maxAbsScore, maxAbsScore);

  const rounds = ctx.completedRoundCount ?? 0;
  const acc = ctx.terminalAccuracy;
  const accStr = acc !== null && Number.isFinite(acc) ? `${Math.round(acc * 100)}% term` : "— term";
  const upPct = (ctx.upLeaderFrac ?? 0.5) * 100;

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: { flipRate, upLeaderFrac: ctx.upLeaderFrac, churn, rounds, terminalAccuracy: acc },
    summary: `PS flips=${flips}/${n} upLead=${upPct.toFixed(0)}% ${accStr} (${rounds} rnd)`
  };
}
