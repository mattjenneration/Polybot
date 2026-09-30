import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "../src/config.js";
import { createSimEngine } from "../src/sim/engine.js";
import { createMarketState } from "../src/sim/marketState.js";
import { generateSyntheticEvents, replaySynthetic } from "../src/sim/synthetic.js";
import { runBacktest } from "../src/scripts/backtest.js";

function testConfig() {
  const c = structuredClone(CONFIG);
  c.sim.startingBankrollUsd = 100;
  c.sim.latencyMs = 400;
  return c;
}

function byId(summary) {
  return Object.fromEntries(summary.strategies.map((s) => [s.id, s]));
}

describe("price to beat latch", () => {
  it("uses the first Chainlink tick at/after the round start, never an earlier one", () => {
    const ms = createMarketState({ feeds: CONFIG.feeds, rounds: { ptbLatchToleranceMs: 3000 } });
    ms.onChainlinkTick({ ts: 9_000, rx: 9_000, price: 1 });
    ms.registerRound({ slug: "r", startMs: 10_000, endMs: 310_000 });
    assert.equal(ms.getRound("r").ptb, null);
    ms.onChainlinkTick({ ts: 10_400, rx: 10_500, price: 2 });
    ms.onChainlinkTick({ ts: 11_000, rx: 11_000, price: 3 });
    assert.equal(ms.getRound("r").ptb, 2);
  });

  it("marks the round as missed when the feed had a gap at the start", () => {
    const ms = createMarketState({ feeds: CONFIG.feeds, rounds: { ptbLatchToleranceMs: 3000 } });
    ms.registerRound({ slug: "r", startMs: 10_000, endMs: 310_000 });
    ms.onChainlinkTick({ ts: 20_000, rx: 20_000, price: 2 });
    assert.equal(ms.getRound("r").ptb, null);
    assert.equal(ms.getRound("r").ptbMissed, true);
  });

  it("refuses to trade on a stale Chainlink price", () => {
    const ms = createMarketState({ feeds: { ...CONFIG.feeds, maxChainlinkAgeMs: 5000 }, rounds: { ptbLatchToleranceMs: 3000 } });
    for (let t = 0; t <= 70_000; t += 1000) ms.onChainlinkTick({ ts: t, rx: t, price: 100 + Math.sin(t) });
    const ctx = ms.buildContext({
      ts: 90_000,
      round: { slug: "r", startMs: 60_000, endMs: 360_000 },
      books: { rx: 90_000, up: { bids: [[0.5, 1]], asks: [[0.52, 1]] }, down: { bids: [[0.48, 1]], asks: [[0.5, 1]] } }
    }, null);
    assert.equal(ctx.tradeable, false);
    assert.equal(ctx.notTradeableReason, "chainlink_stale");
  });
});

describe("simulation engine on synthetic markets", () => {
  it("keeps exact books: equity = start + realized P&L once everything settles", () => {
    const engine = createSimEngine({ config: testConfig() });
    const summary = replaySynthetic(engine, generateSyntheticEvents({ rounds: 30, marketNoise: 0.8, seed: 11 }));
    for (const s of summary.strategies) {
      assert.equal(s.open, 0, s.id);
      assert.ok(Math.abs(s.equity - (s.start + s.pnl)) < 1e-6, `${s.id}: ${s.equity} vs ${s.start + s.pnl}`);
    }
    assert.equal(summary.resolvedRounds, 30);
  });

  it("profits from a noisy market and learns from it", () => {
    const engine = createSimEngine({ config: testConfig() });
    const summary = replaySynthetic(engine, generateSyntheticEvents({ rounds: 150, marketNoise: 0.9, seed: 5 }));
    const s = byId(summary);
    assert.ok(s.conservative.bets > 20, `conservative bets ${s.conservative.bets}`);
    assert.ok(s.conservative.pnl > 0, `conservative pnl ${s.conservative.pnl}`);
    assert.ok(summary.learner.updates > 0);
    const sc = summary.learner.scorecard;
    assert.ok(sc.fair.logLoss < sc.market.logLoss, "fair model should beat a noisy market");
  });

  it("finds little to do in an efficient market (no phantom edge)", () => {
    const engine = createSimEngine({ config: testConfig() });
    const summary = replaySynthetic(engine, generateSyntheticEvents({ rounds: 400, marketNoise: 0, seed: 9 }));
    const s = byId(summary);
    assert.ok(s.conservative.bets <= 3, `conservative bets ${s.conservative.bets}`);
    assert.ok(s["naive-favorite"].bets > 300, "control strategy should trade");
    assert.ok(s["naive-favorite"].returnOnStaked < 0, "paying spread+fees into a fair market should lose");
  });

  it("survives a save/restore mid-run", () => {
    const config = testConfig();
    const data = generateSyntheticEvents({ rounds: 12, marketNoise: 0.9, seed: 2 });
    const half = Math.floor(data.events.length / 2);
    const a = createSimEngine({ config });
    replaySynthetic(a, { events: data.events.slice(0, half), resolutions: new Map() });
    const b = createSimEngine({ config });
    assert.equal(b.restore(JSON.parse(JSON.stringify(a.toJSON()))), true);
    assert.deepEqual(byId(b.summary()).conservative.bets, byId(a.summary()).conservative.bets);
  });
});

describe("settlement noise", () => {
  it("learns how far official settlement prices sit from observed ticks", () => {
    const engine = createSimEngine({ config: testConfig() });
    const summary = replaySynthetic(engine, generateSyntheticEvents({ rounds: 200, marketNoise: 0.5, settleNoise: 4e-4, seed: 12 }));
    const est = summary.settlementNoise.stdev;
    assert.ok(Math.abs(est / 4e-4 - 1) < 0.25, `estimated ${est}`);
    assert.ok(summary.ptbCheck.n === 200);
  });
});

describe("backtest over recording files", () => {
  it("replays JSONL recordings with injected outcomes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-"));
    const { events, resolutions } = generateSyntheticEvents({ rounds: 10, marketNoise: 0.9, seed: 4 });
    const file = path.join(dir, "2026-01-01.jsonl");
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const summary = await runBacktest({ files: [file], config: testConfig(), strategyIds: ["all"], outDir: dir, resolutions });
    assert.equal(summary.resolvedRounds, 10);
    const direct = replaySynthetic(createSimEngine({ config: testConfig() }), { events, resolutions });
    assert.deepEqual(byId(summary).conservative.pnl, byId(direct).conservative.pnl);
  });
});
