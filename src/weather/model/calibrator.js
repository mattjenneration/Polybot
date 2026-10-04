/**
 * Learned blend of the weather model with the market: a logarithmic opinion pool over an event's buckets,
 *
 *   p_i ∝ exp( w · x_i ),  x_i = [ln p_wx, ln p_mkt, d0·ln p_wx, d0·ln p_mkt, Δ logit p_mkt ]
 *
 * trained with the categorical log loss on resolved events (AdaGrad, L2 toward a 50/50 geometric pool).
 * The weights say how much to trust the forecast vs the crowd, on the day itself vs before it, and whether
 * recent market moves keep going (positive Δ weight) or revert. Scoring is prequential: each checkpoint is
 * scored with the probabilities that were live at the time, before the event trains the model.
 */
import { clamp, logit } from "../../core/math.js";
import { brier, logLoss } from "./distribution.js";

export const CAL_FEATURES = ["wx", "market", "wx_x_d0", "market_x_d0", "market_move"];
const PRIOR = [0.5, 0.5, 0, 0, 0];
const P_FLOOR = 1e-4;

const isD0 = (bin) => bin === "post" || String(bin).startsWith("d0");

export function calibratorFeatures({ pWx, pMkt, pMktPrev = null, leadBin }) {
  const d0 = isD0(leadBin) ? 1 : 0;
  return pWx.map((pw, i) => {
    const lw = Math.log(Math.max(P_FLOOR, pw));
    const lm = pMkt ? Math.log(Math.max(P_FLOOR, pMkt[i])) : lw;
    const move = pMkt && pMktPrev ? clamp(logit(pMkt[i]) - logit(pMktPrev[i]), -2, 2) : 0;
    return [lw, lm, d0 * lw, d0 * lm, move];
  });
}

function softmax(scores) {
  const m = Math.max(...scores);
  const e = scores.map((s) => Math.exp(s - m));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / z);
}

function emptyScore() {
  return { n: 0, ll: { wx: 0, mkt: 0, final: 0 }, brier: { wx: 0, mkt: 0, final: 0 } };
}

export function createCalibrator({ learningRate = 0.05, l2 = 0.02 } = {}) {
  let w = [...PRIOR];
  let g2 = w.map(() => 0);
  let updates = 0;
  const scores = { all: emptyScore(), byBin: {}, byCity: {} };

  function predict(xs) {
    return softmax(xs.map((x) => x.reduce((a, xi, j) => a + w[j] * xi, 0)));
  }

  function addScore(s, probs, winner) {
    s.n += 1;
    for (const k of ["wx", "mkt", "final"]) {
      if (!probs[k]) continue;
      s.ll[k] += logLoss(probs[k], winner);
      s.brier[k] += brier(probs[k], winner);
    }
  }

  /**
   * Train on one resolved event.
   * @param {{ xs: number[][], pWx: number[], pMkt: number[]|null, pFinal: number[], leadBin: string }[]} samples
   * @param {number} winner  index of the winning bucket
   * @param {string} cityKey e.g. "NYC|high"
   */
  function learnEvent(samples, winner, cityKey, { train = true } = {}) {
    const valid = samples.filter((s) => Array.isArray(s.xs) && s.xs.length > winner && s.xs[0]?.length === w.length);
    if (!valid.length) return;
    // Event-level score = mean over its checkpoints (long-lived events don't count more)
    const ev = emptyScore();
    for (const s of valid) {
      const probs = { wx: s.pWx, mkt: s.pMkt, final: s.pFinal ?? s.pWx };
      addScore(ev, probs, winner);
      addScore((scores.byBin[s.leadBin] ??= emptyScore()), probs, winner);
    }
    for (const target of [scores.all, (scores.byCity[cityKey] ??= emptyScore())]) {
      target.n += 1;
      for (const k of ["wx", "mkt", "final"]) {
        target.ll[k] += ev.ll[k] / ev.n;
        target.brier[k] += ev.brier[k] / ev.n;
      }
    }
    if (!train) return;
    const grad = w.map(() => 0);
    for (const s of valid) {
      const p = predict(s.xs);
      for (let i = 0; i < p.length; i += 1) {
        const r = p[i] - (i === winner ? 1 : 0);
        for (let j = 0; j < w.length; j += 1) grad[j] += (r * s.xs[i][j]) / valid.length;
      }
    }
    for (let j = 0; j < w.length; j += 1) {
      const g = grad[j] + l2 * (w[j] - PRIOR[j]);
      g2[j] += g * g;
      w[j] -= (learningRate * g) / Math.sqrt(g2[j] + 1e-2);
    }
    updates += 1;
  }

  const fmt = (s) => (s.n ? {
    n: s.n,
    logLoss: { wx: s.ll.wx / s.n, mkt: s.ll.mkt / s.n, final: s.ll.final / s.n },
    brier: { wx: s.brier.wx / s.n, mkt: s.brier.mkt / s.n, final: s.brier.final / s.n }
  } : { n: 0 });

  return {
    predict,
    learnEvent,
    weights: () => Object.fromEntries(CAL_FEATURES.map((n, i) => [n, w[i]])),
    updates: () => updates,
    scorecard() {
      return {
        all: fmt(scores.all),
        byBin: Object.fromEntries(Object.entries(scores.byBin).map(([k, v]) => [k, fmt(v)])),
        byCity: Object.fromEntries(Object.entries(scores.byCity).map(([k, v]) => [k, fmt(v)]))
      };
    },
    toJSON: () => ({ w, g2, updates, scores }),
    restore(st) {
      if (!st || !Array.isArray(st.w) || st.w.length !== PRIOR.length) return;
      w = st.w.map(Number);
      g2 = Array.isArray(st.g2) && st.g2.length === w.length ? st.g2.map(Number) : w.map(() => 0);
      updates = Number(st.updates) || 0;
      if (st.scores?.all) Object.assign(scores, st.scores);
    }
  };
}
