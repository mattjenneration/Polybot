import { clamp, logit, sigmoid } from "../core/math.js";

/**
 * Online logistic model for P(UP), trained on every settled round.
 *
 *   logit P(up) = w · x
 *   x = [1, logit(pFair), logit(pMarket), leadZ, bookImbalance, logit(pFair) * timeFrac]
 *
 * Starts at a 50/50 blend of the volatility model and the market price, then moves its weights
 * toward whatever has actually predicted outcomes (RMSProp SGD, L2-shrunk toward the prior so a
 * few noisy rounds can't throw it far off). Scoring is prequential: each sample is scored
 * before it is trained on, so the scorecard is honest out-of-sample performance.
 */
export const FEATURE_NAMES = ["bias", "fair", "market", "lead", "imbalance", "fair_x_time"];
const PRIOR = [0, 0.5, 0.5, 0, 0, 0];
const LOGIT_CAP = 6;

export function buildFeatures({ pFair, pMarket, leadZ, imbalance, secondsLeft, roundSeconds = 300 }) {
  if (pFair === null || pMarket === null) return null;
  const lf = clamp(logit(pFair), -LOGIT_CAP, LOGIT_CAP);
  const lm = clamp(logit(pMarket), -LOGIT_CAP, LOGIT_CAP);
  const timeFrac = clamp(secondsLeft / roundSeconds, 0, 1);
  return [1, lf, lm, clamp(leadZ ?? 0, -5, 5), clamp(imbalance ?? 0, -1, 1), lf * timeFrac];
}

function emptyScore() {
  return { n: 0, logLoss: 0, brier: 0 };
}

function addScore(s, p, y) {
  const q = clamp(p, 1e-4, 1 - 1e-4);
  s.n += 1;
  s.logLoss += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
  s.brier += (p - y) ** 2;
}

function emptyCalibration() {
  return Array.from({ length: 10 }, () => ({ n: 0, sumP: 0, wins: 0 }));
}

function addCalibration(cal, p, y) {
  const b = cal[Math.min(9, Math.max(0, Math.floor(p * 10)))];
  b.n += 1;
  b.sumP += p;
  b.wins += y;
}

export function createLearner({ learningRate = 0.05, l2 = 0.01 } = {}) {
  let w = [...PRIOR];
  let g2 = w.map(() => 0);
  let updates = 0;
  const scores = { learned: emptyScore(), fair: emptyScore(), market: emptyScore() };
  const calibration = { learned: emptyCalibration(), fair: emptyCalibration(), market: emptyCalibration() };

  function predict(x) {
    if (!x) return null;
    let z = 0;
    for (let i = 0; i < w.length; i += 1) z += w[i] * x[i];
    return sigmoid(z);
  }

  /**
   * Train on one settled round. Samples from the same round share an outcome and are highly
   * correlated, so their gradients are averaged into a single step (AdaGrad-scaled, so steps
   * shrink as evidence accumulates instead of random-walking).
   * @param {{ x: number[], pFair: number, pMarket: number }[]} samples  @param {0|1} y
   */
  function learnRound(samples, y) {
    const valid = samples.filter((s) => Array.isArray(s.x) && s.x.length === w.length);
    if (!valid.length) return;
    const grad = w.map(() => 0);
    for (const sample of valid) {
      const p = predict(sample.x);
      addScore(scores.learned, p, y);
      addScore(scores.fair, sample.pFair, y);
      addScore(scores.market, sample.pMarket, y);
      addCalibration(calibration.learned, p, y);
      addCalibration(calibration.fair, sample.pFair, y);
      addCalibration(calibration.market, sample.pMarket, y);
      for (let i = 0; i < w.length; i += 1) grad[i] += ((p - y) * sample.x[i]) / valid.length;
    }
    for (let i = 0; i < w.length; i += 1) {
      const g = grad[i] + l2 * (w[i] - PRIOR[i]);
      g2[i] += g * g;
      w[i] -= (learningRate * g) / Math.sqrt(g2[i] + 1e-2);
    }
    updates += 1;
  }

  function learn(sample, y) {
    learnRound([sample], y);
  }

  function scorecard() {
    const out = {};
    for (const [k, s] of Object.entries(scores)) {
      out[k] = s.n ? { n: s.n, logLoss: s.logLoss / s.n, brier: s.brier / s.n } : { n: 0, logLoss: null, brier: null };
    }
    return out;
  }

  return {
    predict,
    learn,
    learnRound,
    scorecard,
    weights: () => Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, w[i]])),
    calibration: () => calibration,
    updates: () => updates,
    toJSON() {
      return { w, g2, updates, scores, calibration };
    },
    restore(state) {
      if (!state || !Array.isArray(state.w) || state.w.length !== PRIOR.length) return;
      w = state.w.map(Number);
      g2 = Array.isArray(state.g2) && state.g2.length === w.length ? state.g2.map(Number) : w.map(() => 0);
      updates = Number(state.updates) || 0;
      for (const k of Object.keys(scores)) {
        if (state.scores?.[k]) scores[k] = { ...emptyScore(), ...state.scores[k] };
        if (Array.isArray(state.calibration?.[k]) && state.calibration[k].length === 10) calibration[k] = state.calibration[k];
      }
    }
  };
}
