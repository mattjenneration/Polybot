import "dotenv/config";
import { CONFIG } from "./config.js";
import { errorToRedactedLogString } from "./logRedact.js";

process.on("unhandledRejection", (reason) => {
  console.error("[btc-assistant] Unhandled rejection:", errorToRedactedLogString(reason));
});
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchBinanceFuturesSnapshot } from "./data/binanceFutures.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { generateConfidenceScore } from "./engines/confidence.js";
import { createPolySwingsCollector } from "./indicators/polySwingsStore.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { executeTradeIfEnabled, getUsdcBalanceUsd } from "./trading/polymarketTrade.js";
import { evaluateLiveTradeGuards } from "./trading/liveTradeGuards.js";
import { getAccountInfo } from "./trading/polymarketRelayerClient.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

function parseArgValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function fmtLocal(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return String(ts ?? "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clip(s, n) {
  const x = String(s ?? "");
  return x.length <= n ? x : `${x.slice(0, Math.max(0, n - 1))}…`;
}

function renderTable(rows, cols) {
  const widths = cols.map((c) => c.width);
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  const header = cols.map((c, idx) => clip(c.label, widths[idx]).padEnd(widths[idx], " ")).join(" │ ");

  const out = [];
  out.push(header);
  out.push(sep);
  for (const r of rows) {
    out.push(
      cols
        .map((c, idx) => {
          const v = c.get(r);
          return clip(v, widths[idx]).padEnd(widths[idx], " ");
        })
        .join(" │ ")
    );
  }
  return out.join("\n");
}

function viewApiLog() {
  const logPath = path.resolve("./logs/api.log");
  if (!fs.existsSync(logPath)) {
    console.log(`No api log found at ${logPath}`);
    process.exit(0);
  }

  const limitRaw = parseArgValue("--limit");
  const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Math.max(1, Math.floor(Number(limitRaw))) : 200;
  const onlyTrades = process.argv.includes("--trades-only");

  const text = fs.readFileSync(logPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== "object") continue;
      if (onlyTrades && obj.type !== "clob_market_order" && obj.type !== "clob_order") continue;
      entries.push(obj);
    } catch {
      // ignore bad lines
    }
  }

  entries.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  const slice = entries.slice(-limit);

  const ANSI_LOCAL = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    gray: "\x1b[90m"
  };

  const rows = slice.map((e) => {
    const req = e.request || {};
    const resp = e.rawResponse || e.response || {};
    const orderId = (e.response && (e.response.orderID ?? e.response.orderId)) ?? resp.orderID ?? resp.orderId ?? null;
    const wentThrough = Boolean(orderId);
    const status = (e.response && e.response.status) ?? resp.status ?? "";
    const worst = req.worstPrice ?? req.price ?? "";
    const amt = req.amountUsd ?? req.amount ?? req.size ?? "";
    const side = req.side ?? "";
    const okMark = wentThrough ? `${ANSI_LOCAL.green}YES${ANSI_LOCAL.reset}` : `${ANSI_LOCAL.red}NO${ANSI_LOCAL.reset}`;
    const statusStr = wentThrough ? `${ANSI_LOCAL.green}${status}${ANSI_LOCAL.reset}` : `${ANSI_LOCAL.gray}${status}${ANSI_LOCAL.reset}`;
    return {
      ts: fmtLocal(e.ts),
      type: e.type ?? "",
      side,
      amount: amt === "" ? "" : Number.isFinite(Number(amt)) ? Number(amt).toFixed(2) : String(amt),
      worstPrice: worst === "" ? "" : Number.isFinite(Number(worst)) ? Number(worst).toFixed(4) : String(worst),
      status: statusStr,
      wentThrough: okMark,
      orderId: orderId ? clip(orderId, 12) : ""
    };
  });

  console.log(
    renderTable(rows, [
      { label: "Time (local)", width: 19, get: (r) => r.ts },
      { label: "Type", width: 15, get: (r) => r.type },
      { label: "Side", width: 5, get: (r) => r.side },
      { label: "$ Amt", width: 7, get: (r) => r.amount },
      { label: "Worst", width: 7, get: (r) => r.worstPrice },
      { label: "Status", width: 12, get: (r) => r.status },
      { label: "OK?", width: 3, get: (r) => r.wentThrough },
      { label: "Order", width: 12, get: (r) => r.orderId }
    ])
  );
  process.exit(0);
}

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

const simulatedTradesBySlug = {};
let simulatedBudget = CONFIG.trading.simBudgetUsd ?? 0;
let simulatedPnl = 0;
const confidenceHistoryBySlug = {};
const recentLiveTradeResults = [];
let circuitBreakerUntilMs = 0;
let lastSignalsLogMs = 0;

function maybeSimulateBestEffortTrade({
  marketSlug,
  timeLeftMin,
  marketUp,
  marketDown,
  ledger,
  confidence,
  now = new Date()
}) {
  if (!marketSlug) return null;

  if (timeLeftMin === null || !Number.isFinite(Number(timeLeftMin))) return null;
  const remaining = Number(timeLeftMin);
  const minWindow = 1.5;
  const maxWindow = 2;
  if (remaining > maxWindow || remaining < minWindow) return null;

  const history = confidenceHistoryBySlug[marketSlug] ?? [];
  const nowMs = now.getTime();
  const recentWindowMs = 60_000;
  const recent = history.filter((h) => Number.isFinite(Number(h.ts)) && nowMs - h.ts <= recentWindowMs);

  let best = null;
  for (const h of recent) {
    if (!Number.isFinite(Number(h.score))) continue;
    if (!best || Math.abs(h.score) > Math.abs(best.score)) {
      best = h;
    }
  }

  const chosenScore = best?.score ?? confidence?.score ?? null;
  const chosenDir = best?.direction ?? null;

  let side = null;
  if (chosenDir === "UP" || chosenDir === "DOWN") {
    side = chosenDir;
  } else if (Number.isFinite(Number(chosenScore))) {
    side = Number(chosenScore) >= 0 ? "UP" : "DOWN";
  }

  if (!side) return null;

  const rawPrice = side === "UP" ? marketUp : marketDown;
  if (rawPrice === null || rawPrice === undefined || !Number.isFinite(Number(rawPrice))) return null;

  const priceUsd = Number(rawPrice);
  if (priceUsd <= 0 || !Number.isFinite(priceUsd)) return null;

  const key = marketSlug;
  const state = ledger[key] ?? { spentUsd: 0, trades: 0 };
  const betAmount = Number(CONFIG.trading.simBetAmountUsd ?? 0);
  if (!Number.isFinite(betAmount) || betAmount <= 0) return null;

  if (simulatedBudget < betAmount) return null;

  const maxPerRound = betAmount;

  if (state.spentUsd >= maxPerRound) return null;

  const remainingBudget = Math.min(maxPerRound - state.spentUsd, betAmount);
  const qty = remainingBudget / priceUsd;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const cost = qty * priceUsd;

  const trade = {
    at: now.toISOString(),
    marketSlug,
    side,
    timeLeftMin: remaining,
    priceUsd,
    quantity: qty,
    costUsd: cost,
    confidenceScore: chosenScore ?? null,
    confidenceDirection: best?.direction ?? confidence?.direction ?? null
  };

  ledger[key] = {
    spentUsd: state.spentUsd + cost,
    trades: state.trades + 1
  };

  simulatedTradesBySlug[key] = trade;
  simulatedBudget -= cost;

  return trade;
}

applyGlobalProxyFromEnv();

if (process.argv.includes("--api-log")) {
  viewApiLog();
}

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

const predictionCheckpointSeconds = Array.isArray(CONFIG.trading?.predictionCheckpointsSeconds)
  ? CONFIG.trading.predictionCheckpointsSeconds
  : [120, 90, 60];
const predictionHistoryByCheckpoint = Object.fromEntries(predictionCheckpointSeconds.map((sec) => [sec, []]));
const activePredictionsByCheckpoint = Object.fromEntries(predictionCheckpointSeconds.map((sec) => [sec, null]));
const gptConfidenceHistory = [];
const decisionTelemetryBySlug = {};
const bidDecisionQueueBySlug = {};
const gptIndicatorLogHeader = [
  "timestamp",
  "market_slug",
  "time_left_min",
  "confidence_score",
  "confidence_direction",
  "ta_score",
  "gpt_composite_score",
  "gpt_direction",
  "gpt_confidence",
  "funding_score",
  "funding_confidence",
  "funding_value",
  "open_interest_score",
  "open_interest_confidence",
  "open_interest_value",
  "long_short_score",
  "long_short_confidence",
  "long_short_value",
  "basis_score",
  "basis_confidence",
  "basis_value",
  "polymarket_micro_score",
  "polymarket_micro_confidence",
  "futures_basis_pct",
  "futures_funding_rate",
  "futures_open_interest_delta_pct",
  "futures_long_short_ratio"
];

function renderPredictionHistoryRow(label, history) {
  if (!history.length) {
    return kv(label, `${ANSI.gray}n/a${ANSI.reset}`);
  }

  const maxShown = 50;
  const slice = history.slice(0, maxShown);
  const parts = [];

  for (const p of slice) {
    const arrow = p.side === "UP" ? "↑" : "↓";
    const color = p.correct === true ? ANSI.green : p.correct === false ? ANSI.red : ANSI.gray;
    parts.push(`${color}${arrow}${ANSI.reset}`);
  }

  return kv(label, parts.join(" "));
}

function renderSignedTrend(history, maxShown = 16) {
  const slice = (Array.isArray(history) ? history : []).slice(0, maxShown);
  if (!slice.length) return `${ANSI.gray}n/a${ANSI.reset}`;

  return slice
    .map((v) => {
      if (!Number.isFinite(Number(v)) || Number(v) === 0) return `${ANSI.gray}·${ANSI.reset}`;
      if (Number(v) > 0) return `${ANSI.green}↑${ANSI.reset}`;
      return `${ANSI.red}↓${ANSI.reset}`;
    })
    .join(" ");
}

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

function recordDecisionTelemetry({ marketSlug, confidenceScore, taPredictScore, nowMs }) {
  if (!marketSlug || !Number.isFinite(nowMs)) return;
  const history = decisionTelemetryBySlug[marketSlug] ?? [];
  history.push({
    ts: nowMs,
    confidenceScore: Number.isFinite(Number(confidenceScore)) ? Number(confidenceScore) : null,
    taPredictScore: Number.isFinite(Number(taPredictScore)) ? Number(taPredictScore) : null
  });
  const cutoff = nowMs - 10 * 60_000;
  decisionTelemetryBySlug[marketSlug] = history.filter((x) => Number.isFinite(x.ts) && x.ts >= cutoff).slice(-1200);
}

function queueBidDecision({
  marketSlug,
  side,
  confidenceScore,
  taPredictScore,
  status,
  reason,
  amountUsd,
  orderId,
  tokenId,
  nowIso
}) {
  if (!marketSlug || !side || (side !== "UP" && side !== "DOWN")) return;
  const queue = bidDecisionQueueBySlug[marketSlug] ?? [];
  queue.push({
    timestamp: nowIso,
    side,
    confidenceScore: Number.isFinite(Number(confidenceScore)) ? Number(confidenceScore) : null,
    taPredictScore: Number.isFinite(Number(taPredictScore)) ? Number(taPredictScore) : null,
    status: String(status ?? ""),
    reason: String(reason ?? ""),
    amountUsd: Number.isFinite(Number(amountUsd)) ? Number(amountUsd) : null,
    orderId: orderId ?? "",
    tokenId: tokenId ?? ""
  });
  bidDecisionQueueBySlug[marketSlug] = queue.slice(-200);
}

function meanAbsDeviation(values, baseline) {
  if (!Array.isArray(values) || !values.length || !Number.isFinite(Number(baseline))) return null;
  const baselineNum = Number(baseline);
  const deltas = values
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .map((x) => Math.abs(x - baselineNum));
  if (!deltas.length) return null;
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

function flushBidDecisionOutcomes({ marketSlug, resolvedAtMs, priceToBeat, finalPrice }) {
  const decisions = bidDecisionQueueBySlug[marketSlug] ?? [];
  if (!decisions.length) return;
  const outcomeSide = finalPrice > priceToBeat ? "UP" : finalPrice < priceToBeat ? "DOWN" : null;
  const telemetry = decisionTelemetryBySlug[marketSlug] ?? [];
  const windowStart = resolvedAtMs - 30_000;
  const preOutcome = telemetry.filter((x) => Number.isFinite(x.ts) && x.ts >= windowStart && x.ts <= resolvedAtMs);

  for (const d of decisions) {
    const confSwingMeanAbs = meanAbsDeviation(preOutcome.map((x) => x.confidenceScore), d.confidenceScore);
    const taPredictSwingMeanAbs = meanAbsDeviation(preOutcome.map((x) => x.taPredictScore), d.taPredictScore);
    const outcome =
      d.side && outcomeSide
        ? (d.side === outcomeSide ? "WIN" : "LOSS")
        : "PENDING";
    const decisionType = d.status === "ok" ? "made" : "skipped";
    try {
      appendCsvRow("./logs/bid_decisions_outcomes.csv", [
        "resolved_at",
        "timestamp",
        "market_slug",
        "side",
        "decision_type",
        "status",
        "reason",
        "amount_usd",
        "order_id",
        "token_id",
        "confidence_score",
        "confidence_swing_mean_abs_30s",
        "ta_predict_score",
        "ta_predict_swing_mean_abs_30s",
        "price_to_beat",
        "final_price",
        "outcome"
      ], [
        new Date(resolvedAtMs).toISOString(),
        d.timestamp,
        marketSlug,
        d.side,
        decisionType,
        d.status,
        d.reason,
        d.amountUsd !== null ? d.amountUsd.toFixed(2) : "",
        d.orderId ?? "",
        d.tokenId ?? "",
        d.confidenceScore !== null ? d.confidenceScore.toFixed(4) : "",
        confSwingMeanAbs !== null ? confSwingMeanAbs.toFixed(4) : "",
        d.taPredictScore !== null ? d.taPredictScore.toFixed(4) : "",
        taPredictSwingMeanAbs !== null ? taPredictSwingMeanAbs.toFixed(4) : "",
        Number(priceToBeat).toFixed(2),
        Number(finalPrice).toFixed(2),
        outcome
      ]);
    } catch {
      // ignore logging errors
    }

    if (
      CONFIG.trading.circuitBreakerEnabled
      && decisionType === "made"
      && (outcome === "WIN" || outcome === "LOSS")
    ) {
      recentLiveTradeResults.push(outcome === "WIN");
      while (recentLiveTradeResults.length > CONFIG.trading.circuitBreakerWindow) {
        recentLiveTradeResults.shift();
      }
      if (recentLiveTradeResults.length >= CONFIG.trading.circuitBreakerMinTrades) {
        const wins = recentLiveTradeResults.filter(Boolean).length;
        const rate = wins / recentLiveTradeResults.length;
        if (rate < CONFIG.trading.circuitBreakerMinWinRate) {
          const pauseMs = CONFIG.trading.circuitBreakerPauseMinutes * 60_000;
          circuitBreakerUntilMs = Math.max(circuitBreakerUntilMs, resolvedAtMs + pauseMs);
        }
      }
    }
  }

  delete bidDecisionQueueBySlug[marketSlug];
  delete decisionTelemetryBySlug[marketSlug];
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  const polySwingsCollector = createPolySwingsCollector();
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  const simulatedTradeLedger = {};
  let lastRealTradeAtMs = 0;
  let loggedFunderOnce = false;

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, klines5m, lastPrice, chainlink, poly, futuresSnapshot] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot(),
        fetchBinanceFuturesSnapshot().catch(() => null)
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const polySwingsContext = polySwingsCollector.getContextForIndicator();
      const confidence = generateConfidenceScore({
        rsi: rsiNow,
        macd,
        vwap: vwapNow,
        btcPrice: lastPrice,
        haCandles: ha,
        polymarketSnapshot: poly,
        spotDelta1m: delta1m,
        spotDelta3m: delta3m,
        futuresSnapshot,
        polySwingsContext
      });

      const gptIndicators = confidence.gptIndicators;

      try {
        await polySwingsCollector.tick({
          poly,
          confidence,
          taScore: confidence.taScore
        });
      } catch {
        // ignore PolySwings persistence errors (network etc.)
      }

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Predict: ${predictValue}`;
      const taPredictScore = (Number.isFinite(Number(pLong)) && Number.isFinite(Number(pShort)))
        ? (Number(pLong) - Number(pShort)) * 100
        : null;

      const marketUpStr =
        marketUp === null || marketUp === undefined ? "-" : `${formatNumber(Number(marketUp) * 100, 0)}¢`;
      const marketDownStr =
        marketDown === null || marketDown === undefined ? "-" : `${formatNumber(Number(marketDown) * 100, 0)}¢`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const deltaLine = `Delta 1/3Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;

      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (CONFIG.trading.enableLiveTrading && CONFIG.polymarket?.funderAddress?.trim() && !loggedFunderOnce) {
        try {
          const accountInfo = await getAccountInfo();
          if (accountInfo?.walletAddress) {
            console.log(`Live trading: Polymarket account (funder) ${accountInfo.walletAddress}`);
            loggedFunderOnce = true;
          }
        } catch {
          // ignore
        }
      }

      if (marketSlug) {
        const history = confidenceHistoryBySlug[marketSlug] ?? [];
        history.unshift({
          ts: Date.now(),
          score: confidence.score,
          direction: confidence.direction,
          timeLeftMin
        });
        confidenceHistoryBySlug[marketSlug] = history.slice(0, 40);
        recordDecisionTelemetry({
          marketSlug,
          confidenceScore: confidence.score,
          taPredictScore,
          nowMs: Date.now()
        });
      }

      gptConfidenceHistory.unshift(gptIndicators.score);
      if (gptConfidenceHistory.length > 64) gptConfidenceHistory.length = 64;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
        const previousPredictions = predictionCheckpointSeconds
          .map((sec) => activePredictionsByCheckpoint[sec])
          .filter((p) => p && p.slug && p.slug !== marketSlug);
        if (previousPredictions.length) {
          const primaryPrediction = activePredictionsByCheckpoint[60] ?? previousPredictions[0];
          const resolvedBySlug = {};
          for (const pred of previousPredictions) {
            const finalPrice = pred.lastPrice;
            const ptb = pred.priceToBeat;
            if (finalPrice !== null && ptb !== null && Number.isFinite(Number(finalPrice)) && Number.isFinite(Number(ptb))) {
              const f = Number(finalPrice);
              const b = Number(ptb);
              resolvedBySlug[pred.slug] = { finalPrice: f, priceToBeat: b };
              const correct = pred.side === "UP" ? f > b : pred.side === "DOWN" ? f < b : null;
              const history = predictionHistoryByCheckpoint[pred.checkpointSec] ?? [];
              history.unshift({ slug: pred.slug, side: pred.side, correct });
              if (history.length > 50) history.length = 50;
              predictionHistoryByCheckpoint[pred.checkpointSec] = history;

              try {
                appendCsvRow("./logs/prediction_timing_outcomes.csv", [
                  "settled_at",
                  "market_slug",
                  "checkpoint_sec",
                  "prediction_side",
                  "price_to_beat",
                  "final_price",
                  "correct"
                ], [
                  new Date().toISOString(),
                  pred.slug,
                  pred.checkpointSec,
                  pred.side ?? "",
                  b.toFixed(2),
                  f.toFixed(2),
                  String(correct)
                ]);
              } catch {
                // ignore logging errors
              }

              if (primaryPrediction && pred.checkpointSec === primaryPrediction.checkpointSec) {
                const simulated = simulatedTradesBySlug[pred.slug];
                if (simulated) {
                  const win = correct === true;
                  const stake = simulated.costUsd;
                  const price = simulated.priceUsd;
                  const size = simulated.quantity;
                  const pnlUsd = win ? size * (1 - price) : -size * price;
                  simulatedPnl += pnlUsd;
                  simulatedBudget += stake + pnlUsd;
                  try {
                    appendCsvRow("./logs/simulated_trades.csv", [
                      "settled_at",
                      "market_slug",
                      "side",
                      "entry_time",
                      "entry_time_left_min",
                      "entry_price_usd",
                      "cost_usd",
                      "price_to_beat",
                      "final_price",
                      "correct",
                      "confidence_score",
                      "confidence_direction",
                      "pnl_usd",
                      "budget_after_usd"
                    ], [
                      new Date().toISOString(),
                      pred.slug,
                      simulated.side ?? pred.side ?? "",
                      simulated.at,
                      simulated.timeLeftMin.toFixed(3),
                      simulated.priceUsd.toFixed(4),
                      simulated.costUsd.toFixed(4),
                      b.toFixed(2),
                      f.toFixed(2),
                      String(correct),
                      simulated.confidenceScore ?? "",
                      simulated.confidenceDirection ?? "",
                      pnlUsd.toFixed(4),
                      simulatedBudget.toFixed(4)
                    ]);
                  } catch {
                    // ignore logging errors
                  }
                  delete simulatedTradesBySlug[pred.slug];
                }
              }
            }
          }
          const resolvedAtMs = Date.now();
          for (const [slug, resolved] of Object.entries(resolvedBySlug)) {
            flushBidDecisionOutcomes({
              marketSlug: slug,
              resolvedAtMs,
              priceToBeat: resolved.priceToBeat,
              finalPrice: resolved.finalPrice
            });
          }
          for (const sec of predictionCheckpointSeconds) {
            activePredictionsByCheckpoint[sec] = null;
          }
        }
      }

      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
        }
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;
      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const betType = confidence.score > 0 ? "UP" : confidence.score < 0 ? "DOWN" : "NO TRADE";

      if (marketSlug) {
        const timeLeftSec = Number.isFinite(Number(timeLeftMin)) ? Number(timeLeftMin) * 60 : null;
        for (const checkpointSec of predictionCheckpointSeconds) {
          const existing = activePredictionsByCheckpoint[checkpointSec];
          if (existing && existing.slug === marketSlug) {
            existing.priceToBeat = priceToBeat ?? existing.priceToBeat;
            existing.lastPrice = currentPrice ?? existing.lastPrice;
          }
          const shouldCapture = timeLeftSec !== null
            && timeLeftSec <= checkpointSec
            && (!existing || existing.slug !== marketSlug);
          if (shouldCapture) {
            activePredictionsByCheckpoint[checkpointSec] = {
              slug: marketSlug,
              checkpointSec,
              side: betType === "UP" || betType === "DOWN" ? betType : null,
              priceToBeat,
              lastPrice: currentPrice
            };
          }
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotLine = `${binanceSpotBaseLine}${diffLine}`;
      const binanceSpotValue = binanceSpotLine.split(": ")[1] ?? binanceSpotLine;
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;
      const timeLeftLine = `⏱ Time left: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      const confidenceLine = kv(
        "Confidence:",
        `${confidence.score.toFixed(0)} (${confidence.direction})  ${ANSI.dim}TA ${confidence.taScore?.toFixed(0) ?? "-"} · aux ${confidence.auxiliaryScore?.toFixed(0) ?? "-"}${ANSI.reset}`
      );
      const gptDirectionColor = gptIndicators.direction === "UP"
        ? ANSI.green
        : gptIndicators.direction === "DOWN"
          ? ANSI.red
          : ANSI.gray;
      const gptLine = kv(
        "Context (futures/OB):",
        `${gptDirectionColor}${gptIndicators.direction}${ANSI.reset} ${gptDirectionColor}${gptIndicators.score >= 0 ? "+" : ""}${gptIndicators.score.toFixed(0)}${ANSI.reset} (${gptIndicators.confidence}%)`
      );
      const topGpt = [...gptIndicators.indicators]
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
        .slice(0, 3)
        .map((x) => `${x.name}:${x.score >= 0 ? "+" : ""}${x.score}`)
        .join(" | ");
      const gptBreakdownLine = kv("GPT top:", topGpt || `${ANSI.gray}-${ANSI.reset}`);
      const ps = gptIndicators.byName?.polyswings;
      const polySwingsLine = kv(
        "PolySwings:",
        ps
          ? `${ANSI.dim}${ps.summary}${ANSI.reset} (${ps.score >= 0 ? "+" : ""}${ps.score})`
          : `${ANSI.gray}-${ANSI.reset}`
      );
      const gptTrendLine = kv("GPT trend:", renderSignedTrend(gptConfidenceHistory, 14));
      const success120Row = renderPredictionHistoryRow("Success @120s:", predictionHistoryByCheckpoint[120] ?? []);
      const success90Row = renderPredictionHistoryRow("Success @90s:", predictionHistoryByCheckpoint[90] ?? []);
      const success60Row = renderPredictionHistoryRow("Success:", predictionHistoryByCheckpoint[60] ?? []);
      let budgetLine;
      let accountBalanceUsd = null;
      if (CONFIG.trading.enableLiveTrading) {
        try {
          accountBalanceUsd = await getUsdcBalanceUsd();
        } catch {
          // ignore
        }
        budgetLine = kv(
          "Budget:",
          accountBalanceUsd !== null ? `$${formatNumber(accountBalanceUsd, 2)}` : `${ANSI.gray}-${ANSI.reset}`
        );
      } else {
        budgetLine = kv(
          "Budget:",
          `$${formatNumber(simulatedBudget, 2)} (PnL: ${simulatedPnl >= 0 ? "+" : ""}$${formatNumber(simulatedPnl, 2)})`
        );
      }

      const liveTradeSide = confidence.score > 0 ? "UP" : confidence.score < 0 ? "DOWN" : null;
      const liveAbsConfidence = Math.abs(confidence.score);
      const liveEffThreshold =
        CONFIG.trading.tradeThreshold + (liveTradeSide === "DOWN" ? CONFIG.trading.downSideExtraThreshold : 0);
      const liveTimeLeftSecFull =
        timeLeftMin !== null && Number.isFinite(Number(timeLeftMin)) ? Number(timeLeftMin) * 60 : null;
      const eligibilityNow = Date.now();
      const liveMinsSince = lastRealTradeAtMs === 0 ? Infinity : (eligibilityNow - lastRealTradeAtMs) / 60_000;
      const liveInCooldown = liveMinsSince < CONFIG.trading.cooldownMinutes;
      const circuitPaused = CONFIG.trading.circuitBreakerEnabled && eligibilityNow < circuitBreakerUntilMs;

      const baseLiveEligible =
        CONFIG.trading.enableLiveTrading &&
        !liveInCooldown &&
        !circuitPaused &&
        liveTradeSide !== null &&
        liveAbsConfidence >= liveEffThreshold &&
        liveTimeLeftSecFull !== null &&
        liveTimeLeftSecFull <= CONFIG.trading.tradeTimingSeconds &&
        liveTimeLeftSecFull >= 0 &&
        poly.ok;

      let liveGuardResult = { ok: true };
      if (baseLiveEligible && marketSlug) {
        liveGuardResult = evaluateLiveTradeGuards({
          rec,
          edge,
          tradeSide: liveTradeSide,
          marketUp,
          marketDown,
          orderbook: poly.orderbook,
          liveMinModelEdge: CONFIG.trading.liveMinModelEdge,
          coinFlipMinPrice: CONFIG.trading.coinFlipMinPrice,
          coinFlipMaxPrice: CONFIG.trading.coinFlipMaxPrice,
          maxConfidenceSwingMeanAbs: CONFIG.trading.maxConfidenceSwingMeanAbs,
          confidenceHistory: confidenceHistoryBySlug[marketSlug] ?? [],
          nowMs: eligibilityNow,
          chopWindowMs: CONFIG.trading.chopWindowMs,
          confidenceScore: confidence.score,
          requireEdgeAlignment: CONFIG.trading.requireEdgeEngineEnter,
          enforceCoinFlipGuard: CONFIG.trading.enforceCoinFlipGuard,
          enforceChopGuard: CONFIG.trading.enforceChopGuard
        });
      } else if (baseLiveEligible && !marketSlug) {
        liveGuardResult = { ok: false, reason: "missing_market_slug" };
      }

      const shouldAttemptRealTrade = baseLiveEligible && liveGuardResult.ok;

      let liveTradeBlockReason = "ok";
      if (!CONFIG.trading.enableLiveTrading) liveTradeBlockReason = "live_disabled";
      else if (liveInCooldown) liveTradeBlockReason = "cooldown";
      else if (circuitPaused) liveTradeBlockReason = "circuit_breaker";
      else if (liveTradeSide === null) liveTradeBlockReason = "flat_confidence";
      else if (liveAbsConfidence < liveEffThreshold) liveTradeBlockReason = "below_effective_threshold";
      else if (
        liveTimeLeftSecFull === null
        || liveTimeLeftSecFull > CONFIG.trading.tradeTimingSeconds
        || liveTimeLeftSecFull < 0
      ) {
        liveTradeBlockReason = "outside_timing_window";
      } else if (!poly.ok) liveTradeBlockReason = "bad_market";
      else if (!liveGuardResult.ok) liveTradeBlockReason = liveGuardResult.reason;

      const liveBidLine = kv(
        "Live arm:",
        CONFIG.trading.enableLiveTrading
          ? shouldAttemptRealTrade
            ? `${ANSI.green}YES${ANSI.reset} ${liveTradeSide ?? ""} |conf|≥${liveEffThreshold} edge+filters`
            : `${ANSI.gray}no${ANSI.reset} (${liveTradeBlockReason})`
          : `${ANSI.gray}off${ANSI.reset}`
      );

      const quiet = CONFIG.trading.quietConsole;
      const lines = [
        titleLine,
        marketLine,
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("TA Predict:", predictValue),
        confidenceLine,
        gptLine,
        polySwingsLine,
        ...(quiet ? [] : [gptBreakdownLine, gptTrendLine]),
        budgetLine,
        liveBidLine,
        ...(quiet
          ? []
          : [
              success120Row,
              success90Row,
              success60Row,
              kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
              kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
              kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
              kv("Delta 1/3:", deltaLine.split(": ")[1] ?? deltaLine),
              kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine)
            ]),
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}Currently thinking ${betType}${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      try {
        const snapshot = {
          updatedAt: new Date().toISOString(),
          market: {
            question: poly.ok ? String(poly.market?.question ?? "") : "",
            slug: marketSlug,
            liquidity,
            timeLeftMin,
            settlementLeftMin,
            up: marketUp,
            down: marketDown,
            priceToBeat,
            chainlinkPrice: currentPrice,
            binanceSpot: spotPrice
          },
          model: {
            predictUp: timeAware.adjustedUp,
            predictDown: timeAware.adjustedDown,
            confidenceScore: confidence.score,
            confidenceDirection: confidence.direction,
            confidenceTaScore: confidence.taScore,
            confidenceAuxiliaryScore: confidence.auxiliaryScore,
            signal,
            gptDirection: gptIndicators.direction,
            gptScore: gptIndicators.score,
            gptConfidencePct: gptIndicators.confidence,
            polySwings: ps
              ? {
                  score: ps.score,
                  direction: ps.direction,
                  summary: ps.summary,
                  sampleCount: polySwingsContext?.sampleCount ?? 0,
                  leadFlips: polySwingsContext?.leadFlips ?? 0,
                  bidCentMoves: polySwingsContext?.bidCentMoves ?? 0,
                  completedRounds: polySwingsContext?.completedRoundCount ?? 0,
                  terminalAccuracy: polySwingsContext?.terminalAccuracy ?? null,
                  meanConfidence: polySwingsContext?.meanConfidence ?? null,
                  recentRounds: polySwingsContext?.recentRounds ?? []
                }
              : null,
            regime: regimeInfo.regime,
            edgeUp: edge.edgeUp,
            edgeDown: edge.edgeDown
          },
          trading: {
            enableLiveTrading: CONFIG.trading.enableLiveTrading,
            tradeThreshold: CONFIG.trading.tradeThreshold,
            effectiveTradeThreshold: liveEffThreshold,
            downSideExtraThreshold: CONFIG.trading.downSideExtraThreshold,
            liveMinModelEdge: CONFIG.trading.liveMinModelEdge,
            positionSizeUsd: CONFIG.trading.positionSizeUsd,
            cooldownMinutes: CONFIG.trading.cooldownMinutes,
            tradeTimingSeconds: CONFIG.trading.tradeTimingSeconds,
            maxBidPrice: CONFIG.trading.maxBidPrice,
            confidenceMaxBidLadder: CONFIG.trading.confidenceMaxBidLadder ?? [],
            inCooldown: liveInCooldown,
            cooldownRemainingMin:
              liveInCooldown && Number.isFinite(liveMinsSince)
                ? Math.max(0, CONFIG.trading.cooldownMinutes - liveMinsSince)
                : null,
            circuitBreakerActive: circuitPaused,
            circuitBreakerRemainingMin: circuitPaused
              ? Math.max(0, (circuitBreakerUntilMs - eligibilityNow) / 60_000)
              : null,
            wouldAttemptAutoBid: shouldAttemptRealTrade,
            liveTradeBlockReason,
            balanceUsd: CONFIG.trading.enableLiveTrading ? accountBalanceUsd : simulatedBudget,
            simulatedPnlUsd: CONFIG.trading.enableLiveTrading ? null : simulatedPnl
          },
          hints: {
            betType,
            nextAutoSide: confidence.score > 0 ? "UP" : confidence.score < 0 ? "DOWN" : null
          }
        };
        fs.mkdirSync("./logs", { recursive: true });
        fs.writeFileSync(path.join("./logs", "dashboard.json"), JSON.stringify(snapshot), "utf8");
      } catch {
        // ignore dashboard write errors
      }

      renderScreen(lines.join("\n") + "\n");

      const nowMs = Date.now();

      if (shouldAttemptRealTrade) {
        const result = await executeTradeIfEnabled({
          side: liveTradeSide,
          amountUsd: CONFIG.trading.positionSizeUsd,
          marketSnapshot: poly,
          confidenceScore: confidence.score
        });
        queueBidDecision({
          marketSlug,
          side: liveTradeSide,
          confidenceScore: confidence.score,
          taPredictScore,
          status: result.status,
          reason: result.reason ?? result.errorMessage ?? "",
          amountUsd: CONFIG.trading.positionSizeUsd,
          orderId: result.orderId ?? "",
          tokenId: liveTradeSide === "UP" ? poly.tokens?.upTokenId ?? "" : poly.tokens?.downTokenId ?? "",
          nowIso: new Date().toISOString()
        });

        if (result.status === "ok") {
          console.log(`Live trade executed: ${liveTradeSide} $${CONFIG.trading.positionSizeUsd.toFixed(2)} (confidence ${confidence.score.toFixed(0)}) orderId=${result.orderId ?? "-"} `);
        } else {
          const reasonStr = result.reason ?? result.errorMessage ?? "";
          const addrStr = result.reason === "insufficient_usdc" && result.walletAddress
            ? ` from ${result.walletAddress}`
            : "";
          console.log(`Trade skipped: ${result.status} (${reasonStr}${addrStr})`);
        }
        lastRealTradeAtMs = nowMs;
      }

      if (!CONFIG.trading.enableLiveTrading) {
        const simulatedTrade = maybeSimulateBestEffortTrade({
          marketSlug,
          timeLeftMin,
          marketUp,
          marketDown,
          ledger: simulatedTradeLedger,
          confidence,
          confidenceHistory: confidenceHistoryBySlug[marketSlug] ?? []
        });

        if (simulatedTrade) {
          const msg = `Simulated trade: ${simulatedTrade.side} $${simulatedTrade.costUsd.toFixed(2)} (${simulatedTrade.quantity.toFixed(4)} @ $${simulatedTrade.priceUsd.toFixed(4)}) on ${simulatedTrade.marketSlug} with ~${fmtTimeLeft(simulatedTrade.timeLeftMin)} left`;
          console.log(msg);
        }
      }

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      const logSignalsNow =
        CONFIG.trading.logSignalsThrottleMs <= 0
        || Date.now() - lastSignalsLogMs >= CONFIG.trading.logSignalsThrottleMs
        || shouldAttemptRealTrade;

      if (logSignalsNow) {
        lastSignalsLogMs = Date.now();
        appendCsvRow("./logs/signals.csv", header, [
          new Date().toISOString(),
          timing.elapsedMinutes.toFixed(3),
          timeLeftMin.toFixed(3),
          regimeInfo.regime,
          signal,
          timeAware.adjustedUp,
          timeAware.adjustedDown,
          marketUp,
          marketDown,
          edge.edgeUp,
          edge.edgeDown,
          rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE"
        ]);

        const fundingIndicator = gptIndicators.byName.funding;
        const openInterestIndicator = gptIndicators.byName.open_interest;
        const longShortIndicator = gptIndicators.byName.long_short;
        const basisIndicator = gptIndicators.byName.basis;
        const polymarketMicroIndicator = gptIndicators.byName.polymarket_micro;

        appendCsvRow("./logs/gpt_indicators.csv", gptIndicatorLogHeader, [
          new Date().toISOString(),
          marketSlug || "",
          timeLeftMin.toFixed(3),
          confidence.score.toFixed(2),
          confidence.direction,
          confidence.taScore?.toFixed(2) ?? "",
          gptIndicators.score.toFixed(2),
          gptIndicators.direction,
          gptIndicators.confidence,
          fundingIndicator?.score ?? "",
          fundingIndicator?.confidence ?? "",
          fundingIndicator?.value ?? "",
          openInterestIndicator?.score ?? "",
          openInterestIndicator?.confidence ?? "",
          openInterestIndicator?.value ?? "",
          longShortIndicator?.score ?? "",
          longShortIndicator?.confidence ?? "",
          longShortIndicator?.value ?? "",
          basisIndicator?.score ?? "",
          basisIndicator?.confidence ?? "",
          basisIndicator?.value ?? "",
          polymarketMicroIndicator?.score ?? "",
          polymarketMicroIndicator?.confidence ?? "",
          futuresSnapshot?.basisPct ?? "",
          futuresSnapshot?.fundingRate ?? "",
          futuresSnapshot?.openInterestDeltaPct ?? "",
          futuresSnapshot?.longShortRatio ?? ""
        ]);
      }
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${errorToRedactedLogString(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
