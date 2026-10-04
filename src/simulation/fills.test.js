import { test } from "node:test";
import assert from "node:assert/strict";
import { getFeeSchedule, takerFeeUsd, simulateTakerBuy, settleBinaryPosition } from "./fills.js";

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
