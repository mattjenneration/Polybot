import { clamp, normalizeOutcomeProb } from "../utils.js";
import { CONFIG } from "../config.js";
import { evaluateGptIndicators } from "../indicators/gptIndicators.js";

function classifyHaBodyStrength(haCandles) {
  if (!Array.isArray(haCandles) || haCandles.length === 0) {
    return { isLarge: false, isGreen: null };
  }

  const last = haCandles[haCandles.length - 1];
  const lastBody = Number(last.body ?? 0);
  if (!Number.isFinite(lastBody) || lastBody <= 0) {
    return { isLarge: false, isGreen: last.isGreen ?? null };
  }

  const bodies = haCandles.slice(0, -1).map((c) => Number(c.body ?? 0)).filter((x) => Number.isFinite(x) && x > 0);
  const baseline = bodies.length ? bodies.reduce((a, b) => a + b, 0) / bodies.length : lastBody;
  const isLarge = baseline > 0 ? lastBody >= baseline * 1.5 : false;

  return { isLarge, isGreen: !!last.isGreen };
}

export function generateConfidenceScore({
  rsi,
  macd,
  vwap,
  btcPrice,
  haCandles,
  polymarketSnapshot,
  spotDelta1m,
  spotDelta3m,
  futuresSnapshot
}) {
  let taScore = 0;

  if (rsi !== null && rsi !== undefined && Number.isFinite(Number(rsi))) {
    const v = Number(rsi);
    if (v < 30) taScore += 20;
    else if (v > 70) taScore -= 20;
  }

  if (macd && macd.macd !== null && macd.signal !== null && macd.histDelta !== null) {
    const macdLine = Number(macd.macd);
    const signalLine = Number(macd.signal);
    const histDelta = Number(macd.histDelta);
    if (Number.isFinite(macdLine) && Number.isFinite(signalLine) && Number.isFinite(histDelta)) {
      if (macdLine > signalLine && histDelta > 0) {
        taScore += 25;
      } else if (macdLine < signalLine && histDelta < 0) {
        taScore -= 25;
      }
    }
  }

  if (btcPrice !== null && vwap !== null && btcPrice !== undefined && vwap !== undefined) {
    const p = Number(btcPrice);
    const v = Number(vwap);
    if (Number.isFinite(p) && Number.isFinite(v)) {
      if (p > v) taScore += 15;
      else if (p < v) taScore -= 15;
    }
  }

  if (Array.isArray(haCandles) && haCandles.length) {
    const { isLarge, isGreen } = classifyHaBodyStrength(haCandles);
    if (isLarge && isGreen === true) taScore += 20;
    else if (isLarge && isGreen === false) taScore -= 20;
  }

  if (polymarketSnapshot && btcPrice !== null && btcPrice !== undefined) {
    const upProb = normalizeOutcomeProb(polymarketSnapshot.prices?.up ?? null);
    const downProb = normalizeOutcomeProb(polymarketSnapshot.prices?.down ?? null);

    const spotIsPumping = (() => {
      const d1 = spotDelta1m;
      const d3 = spotDelta3m;
      if (d1 === null && d3 === null) return false;
      const anyPos = (d1 !== null && d1 > 0) || (d3 !== null && d3 > 0);
      return anyPos;
    })();

    if (spotIsPumping && upProb !== null && upProb < 0.5) {
      taScore += 20;
    }

    const spotIsDumping = (() => {
      const d1 = spotDelta1m;
      const d3 = spotDelta3m;
      if (d1 === null && d3 === null) return false;
      const anyNeg = (d1 !== null && d1 < 0) || (d3 !== null && d3 < 0);
      return anyNeg;
    })();

    if (spotIsDumping && downProb !== null && downProb < 0.5) {
      taScore -= 20;
    }
  }

  taScore = clamp(taScore, -100, 100);

  const gptIndicators = evaluateGptIndicators({
    futuresSnapshot,
    polymarketSnapshot,
    spotDelta1m,
    spotDelta3m
  });

  const w = CONFIG.confidenceAuxiliaryWeight;
  const score = clamp(taScore + gptIndicators.score * w, -100, 100);

  const direction = score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT";

  return {
    score,
    direction,
    taScore,
    auxiliaryScore: gptIndicators.score,
    gptIndicators
  };
}

