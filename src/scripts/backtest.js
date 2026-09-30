/**
 * Replay recorded market data through the same simulation engine the live bot uses.
 *
 *   npm run backtest                               # every day in logs/recordings
 *   npm run backtest -- --from 2026-09-01 --to 2026-09-07
 *   npm run backtest -- --bankroll 50 --latency 800 --strategies conservative,balanced,adaptive
 *   npm run backtest -- --files path/a.jsonl,path/b.jsonl --out logs/backtests/my-run
 *
 * Official outcomes come from the recording when present, otherwise from Gamma (cached in
 * logs/resolution_cache.json). Each round's outcome is injected RESOLUTION_DELAY_MS after it
 * ends, the way it would arrive live, so the learner never sees the future.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { fetchResolution } from "../data/polymarket.js";
import { createSimEngine } from "../sim/engine.js";
import { eventClock, listRecordingFiles, readEvents } from "../sim/recording.js";
import { formatAdaptive, formatLeaderboard, formatLearner } from "../sim/report.js";
import { appendCsvRow, sleep } from "../utils.js";

const RESOLUTION_DELAY_MS = 60_000;
const CACHE_FILE = "./logs/resolution_cache.json";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function collectRounds(files) {
  const rounds = new Map(); // slug -> endMs
  const recorded = new Map(); // slug -> res event
  let events = 0;
  for await (const e of readEvents(files)) {
    events += 1;
    if (e.type === "snap" && e.round?.slug) rounds.set(e.round.slug, e.round.endMs);
    if (e.type === "res" && (e.outcome === "UP" || e.outcome === "DOWN")) recorded.set(e.slug, e);
  }
  return { rounds, recorded, events };
}

async function resolveAll(rounds, recorded, { offline }) {
  const cache = loadCache();
  const out = new Map();
  let fetched = 0;
  for (const [slug] of rounds) {
    const rec = recorded.get(slug);
    if (rec) {
      out.set(slug, { outcome: rec.outcome, ptb: rec.ptb ?? null, final: rec.final ?? null });
      continue;
    }
    if (cache[slug]) {
      out.set(slug, cache[slug]);
      continue;
    }
    if (offline) continue;
    try {
      const r = await fetchResolution(slug);
      if (r.status === "resolved") {
        cache[slug] = { outcome: r.outcome, ptb: r.ptb, final: r.final };
        out.set(slug, cache[slug]);
      }
      fetched += 1;
      if (fetched % 20 === 0) await sleep(250);
    } catch {
      // leave unresolved → round is voided
    }
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
  return out;
}

export async function runBacktest({ files, config, strategyIds, seed = 42, outDir = null, resolutions }) {
  const tradesCsv = outDir ? path.join(outDir, "trades.csv") : null;
  const header = ["settled_at", "strategy", "market_slug", "side", "execution", "variant", "seconds_left", "avg_price", "shares", "cost_usd", "fee_usd", "p_model", "p_market", "edge_per_share", "outcome", "pnl_usd", "cash_after"];
  if (tradesCsv && fs.existsSync(tradesCsv)) fs.unlinkSync(tradesCsv);

  const engine = createSimEngine({
    config,
    strategyIds,
    seed,
    onTrade: tradesCsv
      ? (t) => appendCsvRow(tradesCsv, header, [
        new Date(t.settledTs).toISOString(), t.strategyId, t.slug, t.side, t.execution, t.variantId ?? "",
        t.secondsLeft.toFixed(1), t.avgPrice.toFixed(4), t.shares.toFixed(4), t.cost.toFixed(4), t.fee.toFixed(5),
        t.pSide.toFixed(4), t.pMarketSide ?? "", t.edgePerShare.toFixed(4), t.outcome, t.pnl.toFixed(4), t.cashAfter.toFixed(4)
      ])
      : null
  });

  // Resolution injection queue, ordered by due time.
  const queue = [];
  const queued = new Set();
  const flushDue = (clock) => {
    queue.sort((a, b) => a.due - b.due);
    while (queue.length && queue[0].due <= clock) {
      const q = queue.shift();
      engine.handle({ type: "res", ts: q.due, slug: q.slug, ...q.res });
    }
  };

  let clock = 0;
  for await (const e of readEvents(files)) {
    if (e.type === "res") continue; // outcomes are injected on a fixed schedule instead
    clock = Math.max(clock, eventClock(e));
    flushDue(clock);
    if (e.type === "snap" && e.round?.slug && !queued.has(e.round.slug)) {
      queued.add(e.round.slug);
      const res = resolutions.get(e.round.slug) ?? { outcome: null };
      queue.push({ slug: e.round.slug, due: e.round.endMs + RESOLUTION_DELAY_MS, res });
    }
    engine.handle(e);
  }
  flushDue(Infinity);
  return engine.summary({ includeCurves: true });
}

async function main() {
  const filesArg = arg("files");
  const files = filesArg
    ? filesArg.split(",").map((s) => s.trim())
    : listRecordingFiles(CONFIG.sim.recordingsDir, { from: arg("from"), to: arg("to") });
  if (!files.length) {
    console.error(`No recordings found in ${CONFIG.sim.recordingsDir}. Run the bot (npm start) to record data first.`);
    process.exit(1);
  }

  const config = structuredClone(CONFIG);
  if (arg("bankroll")) config.sim.startingBankrollUsd = Number(arg("bankroll"));
  if (arg("latency")) config.sim.latencyMs = Number(arg("latency"));
  const strategyIds = arg("strategies") ? arg("strategies").split(",") : config.sim.strategies;
  const outDir = arg("out") ?? path.join("./logs/backtests", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Scanning ${files.length} file(s)…`);
  const { rounds, recorded, events } = await collectRounds(files);
  console.log(`${events} events, ${rounds.size} rounds. Resolving outcomes…`);
  const resolutions = await resolveAll(rounds, recorded, { offline: process.argv.includes("--offline") });
  console.log(`${resolutions.size}/${rounds.size} rounds have official outcomes (the rest are voided).\nReplaying…\n`);

  const summary = await runBacktest({ files, config, strategyIds, seed: Number(arg("seed", 42)), outDir, resolutions });

  console.log(formatLeaderboard(summary));
  console.log(`\n${formatLearner(summary)}\n\n${formatAdaptive(summary, 10)}`);
  console.log(`\nPTB latch check vs official: n=${summary.ptbCheck.n}, mean |Δ| ${summary.ptbCheck.meanAbsDiff?.toFixed(3) ?? "-"}, max ${summary.ptbCheck.maxAbsDiff.toFixed(3)}`);
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nReport: ${path.join(outDir, "summary.json")}  Trades: ${path.join(outDir, "trades.csv")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
