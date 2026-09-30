/**
 * Guard tests for the live order path. Run with: npm run test:trading
 * (Runs with no funder address so nothing can reach the exchange.)
 */
import { describe, it } from "node:test";
import assert from "node:assert";

describe("executeLiveBuy", () => {
  it("refuses without a funder address", async () => {
    const { executeLiveBuy } = await import("./polymarketTrade.js");
    const { CONFIG } = await import("../config.js");
    if (CONFIG.polymarket?.funderAddress?.trim()) return;
    const result = await executeLiveBuy({ tokenId: "1", amountUsd: 5, worstPrice: 0.9 });
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "missing_funder_address");
  });
});

describe("getUsdcBalanceUsd", () => {
  it("returns null when funder address is not set", async () => {
    const { getUsdcBalanceUsd } = await import("./polymarketTrade.js");
    const { CONFIG } = await import("../config.js");
    if (CONFIG.polymarket?.funderAddress?.trim()) return;
    assert.strictEqual(await getUsdcBalanceUsd(), null);
  });
});
