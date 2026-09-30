import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { takerFeeUsd, takerFeePerShare, normalizeFeeSchedule } from "../src/core/fees.js";
import { fairProbUp } from "../src/core/fairValue.js";
import { normalizeBook, simulateTakerBuy, midPrice } from "../src/core/orderbook.js";
import { createVolEstimator } from "../src/core/volatility.js";
import { normCdf } from "../src/core/math.js";

describe("fees", () => {
  it("matches Polymarket's documented example (100 shares @ $0.50 → $1.75)", () => {
    assert.equal(takerFeeUsd(100, 0.5), 1.75);
  });
  it("is cheaper per $ near the extremes", () => {
    assert.ok(takerFeePerShare(0.9) / 0.9 < takerFeePerShare(0.5) / 0.5);
  });
  it("parses Gamma's feeSchedule string", () => {
    const s = normalizeFeeSchedule('{"exponent":1,"rate":0.07,"takerOnly":true,"rebateRate":0.2}');
    assert.deepEqual(s, { rate: 0.07, exponent: 1, takerOnly: true, rebateRate: 0.2 });
  });
});

describe("fairProbUp", () => {
  const sigma = 1e-4;
  it("is 50% at the money", () => {
    assert.ok(Math.abs(fairProbUp({ price: 100, priceToBeat: 100, secondsLeft: 60, sigma }) - 0.5) < 1e-9);
  });
  it("treats an exact tie at expiry as UP", () => {
    assert.equal(fairProbUp({ price: 100, priceToBeat: 100, secondsLeft: 0, sigma }), 1);
  });
  it("gets more certain as time runs out", () => {
    const early = fairProbUp({ price: 100.05, priceToBeat: 100, secondsLeft: 240, sigma });
    const late = fairProbUp({ price: 100.05, priceToBeat: 100, secondsLeft: 10, sigma });
    assert.ok(late > early && late > 0.9);
  });
  it("stays uncertain at expiry when settlement prices are noisy", () => {
    // $10 above the observed start with 2.5bp settlement noise per end is far from certain.
    const p = fairProbUp({ price: 80_010, priceToBeat: 80_000, secondsLeft: 0, sigma, settleVar: 2 * (2.5e-4) ** 2 });
    assert.ok(p > 0.6 && p < 0.75, `p=${p}`);
  });
  it("normCdf is accurate", () => {
    assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
    assert.ok(Math.abs(normCdf(-1) - 0.1587) < 1e-3);
  });
});

describe("order book", () => {
  it("sorts CLOB worst-first levels into best-first", () => {
    const b = normalizeBook({
      bids: [{ price: "0.40", size: "10" }, { price: "0.45", size: "5" }],
      asks: [{ price: "0.60", size: "10" }, { price: "0.55", size: "5" }]
    });
    assert.deepEqual(b.bids[0], [0.45, 5]);
    assert.deepEqual(b.asks[0], [0.55, 5]);
    assert.equal(midPrice(b), 0.5);
  });

  it("walks the asks up to the limit and charges fees", () => {
    const book = { bids: [], asks: [[0.5, 4], [0.52, 100], [0.6, 100]] };
    const fill = simulateTakerBuy(book, { maxUsd: 1000, limitPrice: 0.52, feeSchedule: normalizeFeeSchedule(null) });
    assert.equal(fill.shares, 104);
    assert.ok(fill.feeUsd > 0);
    assert.ok(fill.avgPrice > 0.5 && fill.avgPrice < 0.52);
  });

  it("never spends more than maxUsd including fees", () => {
    const book = { bids: [], asks: [[0.5, 1000]] };
    const fill = simulateTakerBuy(book, { maxUsd: 10, limitPrice: 0.5, feeSchedule: normalizeFeeSchedule(null) });
    assert.ok(fill.costUsd <= 10 + 1e-6);
    assert.ok(fill.costUsd > 9.99);
  });

  it("returns null when the book is above the limit", () => {
    assert.equal(simulateTakerBuy({ asks: [[0.7, 10]] }, { maxUsd: 10, limitPrice: 0.6, feeSchedule: normalizeFeeSchedule(null) }), null);
  });
});

describe("volatility", () => {
  it("recovers the generating volatility", () => {
    const v = createVolEstimator({ halfLifeSec: 3000 });
    let p = 100;
    let seed = 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 20_000; i += 1) {
      const z = Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
      p *= Math.exp(2e-4 * z);
      v.observe(i * 1000, p);
    }
    assert.ok(Math.abs(v.sigma() / 2e-4 - 1) < 0.15, `sigma ${v.sigma()}`);
  });
});
