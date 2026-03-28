import { CONFIG } from "../config.js";
import { clamp } from "../utils.js";
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
  futuresSnapshot = null
}) {
  let score = 0;

  if (rsi !== null && rsi !== undefined && Number.isFinite(Number(rsi))) {
    const v = Number(rsi);
    if (v < 30) score += 20;
    else if (v > 70) score -= 20;
  }

  if (macd && macd.macd !== null && macd.signal !== null && macd.histDelta !== null) {
    const macdLine = Number(macd.macd);
    const signalLine = Number(macd.signal);
    const histDelta = Number(macd.histDelta);
    if (Number.isFinite(macdLine) && Number.isFinite(signalLine) && Number.isFinite(histDelta)) {
      if (macdLine > signalLine && histDelta > 0) {
        score += 25;
      } else if (macdLine < signalLine && histDelta < 0) {
        score -= 25;
      }
    }
  }

  if (btcPrice !== null && vwap !== null && btcPrice !== undefined && vwap !== undefined) {
    const p = Number(btcPrice);
    const v = Number(vwap);
    if (Number.isFinite(p) && Number.isFinite(v)) {
      if (p > v) score += 15;
      else if (p < v) score -= 15;
    }
  }

  if (Array.isArray(haCandles) && haCandles.length) {
    const { isLarge, isGreen } = classifyHaBodyStrength(haCandles);
    if (isLarge && isGreen === true) score += 20;
    else if (isLarge && isGreen === false) score -= 20;
  }

  if (polymarketSnapshot && btcPrice !== null && btcPrice !== undefined) {
    const upPrice = polymarketSnapshot.prices?.up ?? null;
    const downPrice = polymarketSnapshot.prices?.down ?? null;

    const spotIsPumping = (() => {
      const d1 = spotDelta1m;
      const d3 = spotDelta3m;
      if (d1 === null && d3 === null) return false;
      const anyPos = (d1 !== null && d1 > 0) || (d3 !== null && d3 > 0);
      return anyPos;
    })();

    if (spotIsPumping && upPrice !== null && Number.isFinite(Number(upPrice))) {
      const raw = Number(upPrice);
      const upProb = raw > 1 ? raw / 100 : raw;
      if (upProb < 0.5) {
        score += 20;
      }
    }

    const spotIsDumping = (() => {
      const d1 = spotDelta1m;
      const d3 = spotDelta3m;
      if (d1 === null && d3 === null) return false;
      const anyNeg = (d1 !== null && d1 < 0) || (d3 !== null && d3 < 0);
      return anyNeg;
    })();

    if (spotIsDumping && downPrice !== null && Number.isFinite(Number(downPrice))) {
      const raw = Number(downPrice);
      const downProb = raw > 1 ? raw / 100 : raw;
      if (downProb < 0.5) {
        score -= 20;
      }
    }
  }

  const taScore = clamp(score, -100, 100);

  const gptIndicators = evaluateGptIndicators({
    futuresSnapshot,
    polymarketSnapshot,
    spotDelta1m,
    spotDelta3m
  });

  const auxWeight = CONFIG.confidenceAuxiliaryWeight ?? 0.22;
  const combined = clamp(taScore + auxWeight * gptIndicators.score, -100, 100);
  const direction = combined > 0 ? "UP" : combined < 0 ? "DOWN" : "FLAT";

  return {
    score: combined,
    direction,
    taScore,
    auxiliaryScore: gptIndicators.score,
    gptIndicators
  };
}

