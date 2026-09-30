import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideEntry, maxTakerPrice } from "../src/strategy/decide.js";
import { createLearner, buildFeatures } from "../src/strategy/learner.js";
import { createAdaptiveSelector } from "../src/strategy/adaptive.js";
import { STRATEGY_PRESETS } from "../src/strategy/strategies.js";
import { DEFAULT_FEE_SCHEDULE, takerFeePerShare } from "../src/core/fees.js";
import { mulberry32 } from "../src/strategy/adaptive.js";

const conservative = STRATEGY_PRESETS.find((s) => s.id === "conservative");

function ctx(overrides = {}) {
  return {
    tradeable: true,
    ts: 1_000_000,
    slug: "r1",
    secondsLeft: 60,
    probs: { fair: 0.85, market: 0.75, learned: 0.85 },
    books: {
      UP: { bids: [[0.73, 100]], asks: [[0.76, 100], [0.78, 100]] },
      DOWN: { bids: [[0.24, 100]], asks: [[0.27, 100]] }
    },
    feeSchedule: DEFAULT_FEE_SCHEDULE,
    minOrderSize: 5,
    tickSize: 0.01,
    ...overrides
  };
}

const freshRound = () => ({ side: null, bets: 0, lastBetTs: null });

describe("decideEntry", () => {
  it("buys the underpriced side and caps price at the edge limit", () => {
    const d = decideEntry(conservative, ctx(), { cash: 100 }, freshRound());
    assert.equal(d.ok, true);
    assert.equal(d.side, "UP");
    assert.equal(d.refPrice, 0.76);
    const p = d.limitPrice;
    assert.ok(0.85 - p - takerFeePerShare(p) >= conservative.minEdge - 1e-9);
    assert.ok(0.85 - (p + 0.01) - takerFeePerShare(p + 0.01) < conservative.minEdge);
    assert.ok(d.stakeUsd <= 5);
  });

  it("stays out when the edge after fees is too small", () => {
    const d = decideEntry(conservative, ctx({ probs: { fair: 0.79, market: 0.75, learned: 0.79 } }), { cash: 100 }, freshRound());
    assert.equal(d.ok, false);
    assert.equal(d.reason, "no_edge");
  });

  it("respects the entry window", () => {
    const d = decideEntry(conservative, ctx({ secondsLeft: 200 }), { cash: 100 }, freshRound());
    assert.equal(d.reason, "outside_window");
  });

  it("refuses when model and market disagree wildly (usually bad data)", () => {
    const d = decideEntry(conservative, ctx({ probs: { fair: 0.99, market: 0.5, learned: 0.99 } }), { cash: 100 }, freshRound());
    assert.equal(d.reason, "model_market_gap_too_large");
  });

  it("never switches sides within a round", () => {
    const d = decideEntry(conservative, ctx(), { cash: 100 }, { side: "DOWN", bets: 0, lastBetTs: null });
    assert.equal(d.ok, false);
  });

  it("maxTakerPrice finds the highest price that clears the edge", () => {
    const p = maxTakerPrice(0.9, 0.02, DEFAULT_FEE_SCHEDULE, 0.01, 0.99);
    assert.equal(p, 0.87);
  });
});

describe("learner", () => {
  it("learns to trust the informative signal over a noisy one", () => {
    const rng = mulberry32(3);
    const learner = createLearner({ learningRate: 0.03 });
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
    for (let i = 0; i < 6000; i += 1) {
      const pTrue = 1 / (1 + Math.exp(-2 * gauss()));
      const pNoisy = 1 / (1 + Math.exp(-(Math.log(pTrue / (1 - pTrue)) + 1.5 * gauss())));
      const y = rng() < pTrue ? 1 : 0;
      const x = buildFeatures({ pFair: pTrue, pMarket: pNoisy, leadZ: 0, imbalance: 0, secondsLeft: 60 });
      learner.learn({ x, pFair: pTrue, pMarket: pNoisy }, y);
    }
    const w = learner.weights();
    assert.ok(w.fair + w.fair_x_time * 0.2 > w.market + 0.3, JSON.stringify(w));
    const sc = learner.scorecard();
    assert.ok(sc.learned.logLoss < sc.market.logLoss);
  });

  it("round-trips through JSON", () => {
    const a = createLearner();
    a.learn({ x: [1, 1, 1, 0, 0, 0], pFair: 0.7, pMarket: 0.7 }, 1);
    const b = createLearner();
    b.restore(JSON.parse(JSON.stringify(a.toJSON())));
    assert.deepEqual(b.weights(), a.weights());
  });
});

describe("adaptive selector", () => {
  it("only picks variants with a proven positive edge", () => {
    const sel = createAdaptiveSelector({ minSamples: 20 });
    const variants = [{ id: "good" }, { id: "bad" }];
    const rng = mulberry32(9);
    for (let i = 0; i < 1000; i += 1) {
      sel.record("good", rng() < 0.6 ? 0.8 : -1); // +0.08 per $
      sel.record("bad", rng() < 0.5 ? 0.8 : -1); // -0.1 per $
    }
    assert.equal(sel.choose(variants)?.id, "good");
  });

  it("sits out when nothing has proven itself", () => {
    const sel = createAdaptiveSelector({ minSamples: 20 });
    for (let i = 0; i < 5; i += 1) sel.record("a", 1);
    assert.equal(sel.choose([{ id: "a" }]), null);
  });
});
