import { test } from "node:test";
import assert from "node:assert/strict";
import { getFeeSchedule, takerFeeUsd, simulateTakerBuy, settleBinaryPosition } from "./fills.js";
import { createScenarioSimulator } from "./scenarioSimulator.js";

const crypto = getFeeSchedule("crypto");
const weather = getFeeSchedule("weather");

test("fee curve matches published peak ($1.80 crypto / $1.25 weather per 100 shares at 50c)", () => {
  assert.ok(Math.abs(takerFeeUsd({ shares: 100, price: 0.5, schedule: crypto }) - 1.8) < 1e-9);
  assert.ok(Math.abs(takerFeeUsd({ shares: 100, price: 0.5, schedule: weather }) - 1.25) < 1e-9);
  // Fees shrink toward the extremes
  assert.ok(takerFeeUsd({ shares: 100, price: 0.95, schedule: crypto }) < takerFeeUsd({ shares: 100, price: 0.5, schedule: crypto }) * 2);
  assert.equal(takerFeeUsd({ shares: 100, price: 0.5, schedule: getFeeSchedule("none") }), 0);
});

test("taker buy walks the book, respects max price and budget incl. fees", () => {
  const asks = [
    { price: "0.93", size: "5" },
    { price: "0.91", size: "4" },
    { price: "0.97", size: "100" }
  ];
  const fill = simulateTakerBuy({ asks, budgetUsd: 100, maxPrice: 0.95, feeSchedule: crypto });
  assert.equal(fill.status, "partial");
  assert.equal(fill.bestAsk, 0.91);
  assert.ok(Math.abs(fill.shares - 9) < 1e-9);
  assert.equal(fill.worstPrice, 0.93);
  assert.ok(fill.feeUsd > 0);
  assert.ok(Math.abs(fill.totalUsd - (4 * 0.91 + 5 * 0.93 + fill.feeUsd)) < 1e-9);

  const small = simulateTakerBuy({ asks, budgetUsd: 2, maxPrice: 0.95, feeSchedule: crypto });
  assert.equal(small.status, "filled");
  assert.ok(Math.abs(small.totalUsd - 2) < 1e-9);

  assert.equal(simulateTakerBuy({ asks: [{ price: "0.97", size: "10" }], budgetUsd: 5, maxPrice: 0.95, feeSchedule: crypto }).status, "ask_above_max");
  assert.equal(simulateTakerBuy({ asks: [], budgetUsd: 5, maxPrice: 0.95, feeSchedule: crypto }).status, "no_liquidity");
});

test("settlement pays $1 per winning share minus all-in cost", () => {
  assert.deepEqual(settleBinaryPosition({ shares: 10, totalUsd: 9.5, won: true }), { payoutUsd: 10, pnlUsd: 0.5 });
  assert.deepEqual(settleBinaryPosition({ shares: 10, totalUsd: 9.5, won: false }), { payoutUsd: 0, pnlUsd: -9.5 });
});

test("BTC scenario simulator fills against real asks and pays fees", () => {
  const sim = createScenarioSimulator({
    riskAppetite: 0.5,
    riskAppetiteStep: 0.2,
    maxBidPrice: 0.95,
    simBudgetUsd: 100,
    simBetAmountUsd: 10,
    tradeThreshold: 50
  });
  const askBooks = { UP: [{ price: 0.8, size: 1000 }], DOWN: [{ price: 0.25, size: 1000 }] };
  const fills = sim.maybePlaceScenarioTrades({
    marketSlug: "btc-test",
    confidenceScore: 90,
    confidenceDirection: "UP",
    timeLeftMin: 1.8,
    askBooks
  });
  assert.equal(fills.length, 3);
  for (const f of fills) {
    assert.equal(f.bidPrice, 0.8);
    assert.ok(Math.abs(f.amountUsd - 10) < 1e-9);
    assert.ok(f.feeUsd > 0);
    assert.ok(f.shares < 10 / 0.8);
  }
  const settled = sim.settleRound({ marketSlug: "btc-test", finalPrice: 100, priceToBeat: 100 });
  assert.equal(settled.winnerSide, "UP"); // tie resolves Up
  for (const o of settled.scenarioOutcomes) {
    assert.ok(o.roundPnlUsd > 0 && o.roundPnlUsd < 10 / 0.8 - 10);
    assert.ok(Math.abs(o.balanceUsd - (100 + o.roundPnlUsd)) < 1e-9);
  }
});

test("BTC scenario simulator skips when no book or ask above max", () => {
  const sim = createScenarioSimulator({ maxBidPrice: 0.9, simBudgetUsd: 100, simBetAmountUsd: 10, tradeThreshold: 50 });
  assert.equal(sim.maybePlaceScenarioTrades({ marketSlug: "a", confidenceScore: 90, confidenceDirection: "UP", timeLeftMin: 1.8 }).length, 0);
  assert.equal(sim.maybePlaceScenarioTrades({
    marketSlug: "b",
    confidenceScore: 90,
    confidenceDirection: "UP",
    timeLeftMin: 1.8,
    askBooks: { UP: [{ price: 0.96, size: 100 }], DOWN: [] }
  }).length, 0);
  const reasons = sim.getSnapshot().recentDecisions.map((d) => d.reason);
  assert.ok(reasons.includes("no_orderbook"));
  assert.ok(reasons.includes("ask_above_max"));
});
