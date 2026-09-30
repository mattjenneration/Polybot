import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseResolution, roundFromMarket, slugForTime } from "../src/data/polymarket.js";
import { normalizeTimestampMs, parseChainlinkMessage } from "../src/data/chainlinkFeed.js";

const closedEvent = {
  slug: "btc-updown-5m-1790789700",
  eventMetadata: { finalPrice: 83981.2587523443, priceToBeat: 84018.88492569751 },
  markets: [{
    slug: "btc-updown-5m-1790789700",
    closed: true,
    umaResolutionStatus: "resolved",
    outcomes: '["Up", "Down"]',
    outcomePrices: '["0", "1"]',
    clobTokenIds: '["111", "222"]',
    eventStartTime: "2026-09-30T17:35:00Z",
    endDate: "2026-09-30T17:40:00Z",
    feeSchedule: { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 },
    orderMinSize: 5,
    orderPriceMinTickSize: 0.01
  }]
};

describe("Gamma parsing", () => {
  it("reads the official outcome and price to beat", () => {
    assert.deepEqual(parseResolution(closedEvent), {
      status: "resolved",
      outcome: "DOWN",
      ptb: 84018.88492569751,
      final: 83981.2587523443
    });
  });

  it("reports pending while the market is open", () => {
    const open = structuredClone(closedEvent);
    open.markets[0].closed = false;
    open.markets[0].outcomePrices = '["0.62", "0.38"]';
    assert.equal(parseResolution(open).status, "pending");
  });

  it("builds a round descriptor with tokens, fees and limits", () => {
    const r = roundFromMarket(closedEvent.markets[0]);
    assert.equal(r.upTokenId, "111");
    assert.equal(r.downTokenId, "222");
    assert.equal(r.endMs - r.startMs, 300_000);
    assert.equal(r.minOrderSize, 5);
    assert.equal(r.feeSchedule.rate, 0.07);
  });

  it("derives the round slug from the start time", () => {
    assert.equal(slugForTime(Date.parse("2026-09-30T17:37:12Z")), "btc-updown-5m-1790789700");
  });
});

describe("Chainlink messages", () => {
  it("normalizes second and millisecond timestamps", () => {
    assert.equal(normalizeTimestampMs(1790789700), 1790789700000);
    assert.equal(normalizeTimestampMs(1790789700123), 1790789700123);
  });

  it("parses single and batched updates, ignoring other symbols", () => {
    const single = { topic: "crypto_prices_chainlink", payload: { symbol: "btc/usd", timestamp: 1790789700123, value: 84000.5 } };
    assert.deepEqual(parseChainlinkMessage(single, 5), [{ ts: 1790789700123, rx: 5, price: 84000.5 }]);
    const batch = { topic: "crypto_prices_chainlink", payload: { symbol: "btc/usd", data: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }] } };
    assert.equal(parseChainlinkMessage(batch, 0).length, 2);
    const eth = { topic: "crypto_prices_chainlink", payload: { symbol: "eth/usd", timestamp: 1, value: 1 } };
    assert.equal(parseChainlinkMessage(eth, 0).length, 0);
  });
});
