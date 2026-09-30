import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CONFIG } from "./config.js";
import { errorToRedactedLogString } from "./logRedact.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { startChainlinkFeed } from "./data/chainlinkFeed.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { fetchCurrentRound, fetchOrderBook, fetchResolution } from "./data/polymarket.js";
import { createSimEngine } from "./sim/engine.js";
import { createRecorder } from "./sim/recording.js";
import { formatAdaptive, formatLeaderboard, formatLearner } from "./sim/report.js";
import { createLiveExecutor } from "./trading/liveExecutor.js";
import { appendCsvRow } from "./utils.js";

process.on("unhandledRejection", (reason) => {
  console.error("[btc-assistant] Unhandled rejection:", errorToRedactedLogString(reason));
});

applyGlobalProxyFromEnv();

const LOG_DIR = "./logs";
const DASHBOARD_JSON = path.join(LOG_DIR, "dashboard.json");
const SIM_CONTROL_PATH = path.join(LOG_DIR, "sim_controls.json");

const TRADE_HEADER = [
  "settled_at", "strategy", "market_slug", "side", "execution", "variant", "entry_at", "seconds_left",
  "avg_price", "shares", "cost_usd", "fee_usd", "p_model", "p_market", "edge_per_share", "outcome", "won", "pnl_usd", "cash_after"
];

function writeTradeRow(t) {
  appendCsvRow(CONFIG.sim.tradesCsv, TRADE_HEADER, [
    new Date(t.settledTs).toISOString(), t.strategyId, t.slug, t.side, t.execution, t.variantId ?? "",
    new Date(t.ts).toISOString(), t.secondsLeft.toFixed(1), t.avgPrice.toFixed(4), t.shares.toFixed(4),
    t.cost.toFixed(4), t.fee.toFixed(5), t.pSide.toFixed(4), t.pMarketSide === null ? "" : t.pMarketSide.toFixed(4),
    t.edgePerShare.toFixed(4), t.outcome, t.won, t.pnl.toFixed(4), t.cashAfter.toFixed(4)
  ]);
}

function loadState(engine) {
  try {
    if (!fs.existsSync(CONFIG.sim.stateFile)) return false;
    return engine.restore(JSON.parse(fs.readFileSync(CONFIG.sim.stateFile, "utf8")));
  } catch (err) {
    console.error(`[state] could not restore ${CONFIG.sim.stateFile}: ${err.message}`);
    return false;
  }
}

function saveState(engine) {
  try {
    fs.mkdirSync(path.dirname(CONFIG.sim.stateFile), { recursive: true });
    const tmp = `${CONFIG.sim.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(engine.toJSON()), "utf8");
    fs.renameSync(tmp, CONFIG.sim.stateFile);
  } catch (err) {
    console.error(`[state] save failed: ${err.message}`);
  }
}

function fmtSecs(s) {
  if (!Number.isFinite(s)) return "--:--";
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function fmtP(p) {
  return p === null || p === undefined ? "  -  " : `${(p * 100).toFixed(1)}%`;
}

function render({ ctx, round, summary, live, feedStatus }) {
  const annVol = ctx?.sigma ? ctx.sigma * Math.sqrt(365 * 24 * 3600) : null;
  const lines = [
    `${round?.question ?? "Waiting for market…"}`,
    `Market ${round?.slug ?? "-"}   time left ${fmtSecs(ctx?.secondsLeft)}   ${ctx?.tradeable ? "\x1b[32mTRADEABLE\x1b[0m" : `\x1b[33m${ctx?.notTradeableReason ?? "-"}\x1b[0m`}`,
    `Price to beat ${ctx?.ptb?.toFixed(2) ?? "-"}   Chainlink ${ctx?.price?.toFixed(2) ?? "-"} (${feedStatus.clAge})   Binance ${feedStatus.bn}   vol ${annVol ? `${(annVol * 100).toFixed(0)}%/yr` : "-"}`,
    `P(UP)  fair ${fmtP(ctx?.probs?.fair)}   market ${fmtP(ctx?.probs?.market)}   learned ${fmtP(ctx?.probs?.learned)}   books ${feedStatus.books}`,
    "",
    formatLeaderboard(summary),
    "",
    formatLearner(summary),
    ...(CONFIG.console.quiet ? [] : ["", formatAdaptive(summary)]),
    "",
    `Rounds resolved ${summary.resolvedRounds} (void ${summary.voidRounds})   Official vs observed start price: n=${summary.ptbCheck.n} mean |Δ| $${summary.ptbCheck.meanAbsDiff?.toFixed(2) ?? "-"}, ` +
      `settlement noise ${(summary.settlementNoise.stdev * 1e4).toFixed(2)}bp, calls flipped ${summary.ptbCheck.mismatchedOutcomes}   ` +
      `Live: ${live.enabled ? `${live.strategy} — ${live.lastStatus}` : "off (paper only)"}`
  ];
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // not a TTY
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  let liveExecutor = null;
  let currentRound = null;
  const engine = createSimEngine({
    config: CONFIG,
    onTrade: (t) => {
      try {
        writeTradeRow(t);
      } catch {
        // ignore logging errors
      }
    },
    onIntent: (payload) => {
      if (!liveExecutor || !currentRound || payload.ctx.slug !== currentRound.slug) return;
      liveExecutor.onIntent({ ...payload, round: currentRound }).catch(() => {});
    }
  });
  liveExecutor = createLiveExecutor({ config: CONFIG, engine });

  if (loadState(engine)) console.log(`[state] restored from ${CONFIG.sim.stateFile}`);

  const recorder = CONFIG.sim.record ? createRecorder(CONFIG.sim.recordingsDir) : null;
  const emit = (event) => {
    recorder?.write(event);
    return engine.handle(event);
  };

  const chainlink = startChainlinkFeed({ onTick: (t) => emit({ type: "cl", ...t }) });
  const binance = startBinanceTradeStream();

  // Rounds we have seen and still need an official outcome for.
  const awaitingResolution = new Map(); // slug -> endMs
  for (const slug of engine.openSlugs()) awaitingResolution.set(slug, null);

  let books = null; // { rx, slug, up, down }
  let lastSimReset = null;

  async function pollMarket() {
    try {
      const now = Date.now();
      if (currentRound && now < currentRound.endMs) return;
      const r = await fetchCurrentRound(now);
      if (r) {
        currentRound = r;
        awaitingResolution.set(r.slug, r.endMs);
      }
    } catch (err) {
      console.error(`[market] ${errorToRedactedLogString(err)}`);
    }
  }

  async function pollBooks() {
    const r = currentRound;
    if (!r || Date.now() >= r.endMs) return;
    try {
      const [up, down] = await Promise.all([
        fetchOrderBook(r.upTokenId, CONFIG.sim.bookDepth),
        fetchOrderBook(r.downTokenId, CONFIG.sim.bookDepth)
      ]);
      books = { rx: Date.now(), slug: r.slug, up, down };
    } catch {
      // keep the previous snapshot; staleness checks will stop decisions if this persists
    }
  }

  async function pollResolutions() {
    const now = Date.now();
    for (const [slug, endMs] of awaitingResolution) {
      if (endMs !== null && now < endMs + 5000) continue;
      try {
        const res = await fetchResolution(slug);
        if (res.status === "resolved") {
          const event = { type: "res", ts: Date.now(), slug, outcome: res.outcome, ptb: res.ptb, final: res.final };
          emit(event);
          liveExecutor.onResolution(event);
          awaitingResolution.delete(slug);
          saveState(engine);
        } else if (endMs !== null && now - endMs > CONFIG.rounds.resolutionGiveUpMs) {
          emit({ type: "res", ts: Date.now(), slug, outcome: null });
          awaitingResolution.delete(slug);
        }
      } catch {
        // retry on next poll
      }
    }
  }

  function checkSimControls() {
    try {
      if (!fs.existsSync(SIM_CONTROL_PATH)) return;
      const c = JSON.parse(fs.readFileSync(SIM_CONTROL_PATH, "utf8"));
      if (c.resetRequestedAt && c.resetRequestedAt !== lastSimReset) {
        if (lastSimReset !== null) {
          engine.resetAccounts();
          saveState(engine);
        }
        lastSimReset = c.resetRequestedAt;
      }
    } catch {
      // ignore
    }
  }

  const loop = (fn, ms) => {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } finally {
        running = false;
      }
    };
    run();
    return setInterval(run, ms);
  };

  loop(pollMarket, CONFIG.loop.marketPollMs);
  loop(pollBooks, CONFIG.loop.bookPollMs);
  loop(pollResolutions, CONFIG.rounds.resolutionPollMs);
  setInterval(() => saveState(engine), 30_000);

  let lastDashboardWrite = 0;
  setInterval(() => {
    const now = Date.now();
    checkSimControls();
    const bn = binance.getLast();
    const r = currentRound && now < currentRound.endMs + 1000 ? currentRound : null;
    const snap = {
      type: "snap",
      ts: now,
      round: r && {
        slug: r.slug, startMs: r.startMs, endMs: r.endMs, feeSchedule: r.feeSchedule,
        minOrderSize: r.minOrderSize, tickSize: r.tickSize
      },
      binance: bn,
      books: books && r && books.slug === r.slug ? { rx: books.rx, up: books.up, down: books.down } : null
    };
    const ctx = emit(snap);
    const summary = engine.summary();
    const cl = chainlink.getLast();
    const feedStatus = {
      clAge: cl ? `${((now - cl.rx) / 1000).toFixed(1)}s old` : "no data",
      bn: bn ? `${bn.price.toFixed(2)} (${((now - bn.ts) / 1000).toFixed(1)}s)` : "no data",
      books: snap.books ? `${((now - snap.books.rx) / 1000).toFixed(1)}s old` : "none"
    };
    const live = liveExecutor.status();
    render({ ctx, round: r, summary, live, feedStatus });

    if (now - lastDashboardWrite >= 2000) {
      lastDashboardWrite = now;
      try {
        const full = engine.summary({ includeCurves: true });
        fs.writeFileSync(DASHBOARD_JSON, JSON.stringify({
          updatedAt: new Date(now).toISOString(),
          round: r && { slug: r.slug, question: r.question, startMs: r.startMs, endMs: r.endMs },
          context: ctx && {
            secondsLeft: ctx.secondsLeft, ptb: ctx.ptb, price: ctx.price, sigma: ctx.sigma, probs: ctx.probs,
            tradeable: ctx.tradeable, notTradeableReason: ctx.notTradeableReason, leadZ: ctx.leadZ, imbalance: ctx.imbalance
          },
          feeds: feedStatus,
          live,
          sim: full
        }), "utf8");
      } catch {
        // ignore dashboard write errors
      }
    }
  }, CONFIG.loop.tickMs);

  const shutdown = () => {
    saveState(engine);
    recorder?.close();
    chainlink.close();
    binance.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
