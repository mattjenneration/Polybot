import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? "3000");
const LOG_DIR = path.resolve(process.cwd(), "logs");
const API_LOG = path.join(LOG_DIR, "api.log");
const DASHBOARD_JSON = path.join(LOG_DIR, "dashboard.json");
const CACHE_FILE = path.join(LOG_DIR, "outcome_resolution_cache.json");
const GAMMA_BASE = CONFIG.gammaBaseUrl.replace(/\/$/, "");

const FUNDER_ADDRESS = (CONFIG.polymarket?.funderAddress || "").trim();

const app = express();
app.use(express.static(__dirname));

let outcomeCache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    outcomeCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    outcomeCache = {};
  }
}

let cachedData = { trades: [], wallet: { balance: 0, totalValue: 0 }, lastUpdate: null };

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else if (c === '"') {
      inQ = true;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = cells[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

async function getAccountValue() {
  if (!FUNDER_ADDRESS) return null;
  try {
    const res = await fetch(`https://data-api.polymarket.com/total-value?user=${FUNDER_ADDRESS}`);
    if (!res.ok) return null;
    const data = await res.json();
    return parseFloat(data.totalValue ?? data.total_value ?? 0) || 0;
  } catch {
    return null;
  }
}

/**
 * Resolve BTC Up/Down market outcome from Gamma using the outcome token id.
 * CLOB GET /markets/{tokenId} is not valid — token ids are outcome tokens, not condition ids.
 */
async function resolveOutcomeFromGamma(tokenId) {
  const url = `${GAMMA_BASE}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const arr = await res.json();
  const market = Array.isArray(arr) ? arr[0] : null;
  if (!market) return null;

  if (!market.closed || market.umaResolutionStatus !== "resolved") {
    return "PENDING";
  }

  let outcomes;
  let prices;
  try {
    outcomes = JSON.parse(market.outcomes || "[]");
    prices = JSON.parse(market.outcomePrices || "[]");
  } catch {
    return "PENDING";
  }

  let winIdx = -1;
  for (let i = 0; i < prices.length; i += 1) {
    if (Number(prices[i]) >= 0.5) winIdx = i;
  }
  if (winIdx < 0 || !outcomes[winIdx]) return "PENDING";

  const label = String(outcomes[winIdx]);
  const marketOutcome = label.toLowerCase() === "up" ? "UP" : label.toLowerCase() === "down" ? "DOWN" : null;
  if (!marketOutcome) return "PENDING";

  return { marketOutcome, slug: market.slug ?? null };
}

function winLossForSide(tradeSide, marketOutcome) {
  if (!tradeSide || !marketOutcome) return null;
  return tradeSide === marketOutcome ? "WIN" : "LOSS";
}

function reloadOutcomeCache() {
  if (!fs.existsSync(CACHE_FILE)) return;
  try {
    outcomeCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    // keep prior cache
  }
}

async function refreshCache() {
  try {
    reloadOutcomeCache();
    const totalValue = await getAccountValue();
    const trades = [];

    if (fs.existsSync(API_LOG)) {
      const content = fs.readFileSync(API_LOG, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const raw = data.rawResponse || {};
          const ok =
            data.type === "clob_market_order" &&
            raw.success === true &&
            data.request?.tokenId;

          if (!ok) continue;

          const usdSpent = parseFloat(raw.makingAmount);
          const shares = parseFloat(raw.takingAmount);
          const tokenId = data.request.tokenId;
          const side = data.request.side;

          if (!Number.isFinite(usdSpent) || !Number.isFinite(shares) || shares === 0) continue;

          const price = (usdSpent / shares).toFixed(4);
          let result = outcomeCache[tokenId] || "PENDING";

          trades.push({
            ts: data.ts,
            side,
            price,
            usd: usdSpent.toFixed(2),
            result,
            tokenId
          });
        } catch {
          // skip bad line
        }
      }
    }

    const tradeHistory = readCsv(path.join(LOG_DIR, "trade_history.csv"));
    const debugRows = readCsv(path.join(LOG_DIR, "live_trades_debug.csv"));
    const decisionRows = readCsv(path.join(LOG_DIR, "bid_decisions_outcomes.csv"));

    for (const t of trades) {
      const tsMs = new Date(t.ts).getTime();
      let bestConf = null;
      let bestDt = Infinity;
      for (const row of tradeHistory) {
        if (!row.timestamp || String(row.side) !== String(t.side)) continue;
        const rts = new Date(row.timestamp).getTime();
        if (!Number.isFinite(rts)) continue;
        const dt = Math.abs(rts - tsMs);
        if (dt < bestDt && dt < 15_000) {
          bestDt = dt;
          const c = row.confidence_score;
          bestConf = c === "" || c === undefined ? null : Number(c);
        }
      }
      t.confidence = Number.isFinite(bestConf) ? bestConf : null;
      t.confidenceSwingMeanAbs30s = null;
      t.taPredict = null;
      t.taPredictSwingMeanAbs30s = null;

      let slug = null;
      bestDt = Infinity;
      for (const row of debugRows) {
        if (!row.timestamp || String(row.side) !== String(t.side) || String(row.token_id) !== String(t.tokenId)) {
          continue;
        }
        const rts = new Date(row.timestamp).getTime();
        if (!Number.isFinite(rts)) continue;
        const dt = Math.abs(rts - tsMs);
        if (dt < bestDt && dt < 20_000) {
          bestDt = dt;
          slug = row.market_slug || null;
        }
      }
      t.marketSlug = slug;

      let decisionMatch = null;
      bestDt = Infinity;
      for (const row of decisionRows) {
        if (String(row.side) !== String(t.side)) continue;
        if (String(row.token_id || "") && String(row.token_id) !== String(t.tokenId)) continue;
        const rts = new Date(row.timestamp).getTime();
        if (!Number.isFinite(rts)) continue;
        const dt = Math.abs(rts - tsMs);
        if (dt < 25_000 && dt < bestDt) {
          bestDt = dt;
          decisionMatch = row;
        }
      }
      if (decisionMatch) {
        const dc = parseNumberOrNull(decisionMatch.confidence_score);
        const dcs = parseNumberOrNull(decisionMatch.confidence_swing_mean_abs_30s);
        const dtp = parseNumberOrNull(decisionMatch.ta_predict_score);
        const dtps = parseNumberOrNull(decisionMatch.ta_predict_swing_mean_abs_30s);
        if (Number.isFinite(dc)) t.confidence = dc;
        t.confidenceSwingMeanAbs30s = dcs;
        t.taPredict = dtp;
        t.taPredictSwingMeanAbs30s = dtps;
      }
    }

    cachedData = {
      trades: trades.reverse().slice(0, 200),
      wallet: {
        address: FUNDER_ADDRESS || null,
        totalValue
      },
      lastUpdate: new Date().toISOString()
    };

    resolvePending().catch(() => {});
  } catch (err) {
    console.error("Refresh Error:", err?.message ?? err);
  }
}

async function resolvePending() {
  const pending = cachedData.trades.filter(
    (t) => t.result === "PENDING" && Date.now() - new Date(t.ts).getTime() > 120_000
  );

  for (const trade of pending.slice(0, 5)) {
    try {
      const resolved = await resolveOutcomeFromGamma(trade.tokenId);
      if (resolved === "PENDING" || resolved === null) continue;

      const { marketOutcome } = resolved;
      const finalResult = winLossForSide(trade.side, marketOutcome);
      if (finalResult) {
        outcomeCache[trade.tokenId] = finalResult;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(outcomeCache, null, 0));
        const idx = cachedData.trades.findIndex((x) => x.tokenId === trade.tokenId && x.ts === trade.ts);
        if (idx >= 0) cachedData.trades[idx].result = finalResult;
      }
    } catch {
      // ignore
    }
  }
}

function readDashboard() {
  if (!fs.existsSync(DASHBOARD_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(DASHBOARD_JSON, "utf-8"));
  } catch {
    return null;
  }
}

function parseIsoOrNull(s) {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function parseNumberOrNull(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

app.get("/api/live", async (req, res) => {
  const dashboard = readDashboard();
  const totalValue = await getAccountValue();
  res.json({
    dashboard,
    wallet: { address: FUNDER_ADDRESS || null, totalValue },
    lastUpdate: new Date().toISOString()
  });
});

app.get("/api/data", (req, res) => res.json(cachedData));

app.get("/api/history", (req, res) => {
  reloadOutcomeCache();

  const hoursRaw = req.query.hours;
  const fromQ = req.query.from;
  const toQ = req.query.to;

  let fromMs;
  let toMs = Date.now();
  if (fromQ && toQ) {
    fromMs = parseIsoOrNull(fromQ);
    const t = parseIsoOrNull(toQ);
    if (fromMs !== null && t !== null) toMs = t;
  } else {
    const hours = hoursRaw && Number.isFinite(Number(hoursRaw)) ? Math.max(1, Math.min(720, Number(hoursRaw))) : 24;
    fromMs = Date.now() - hours * 3600_000;
  }
  if (fromMs === null) fromMs = Date.now() - 24 * 3600_000;

  const decisionRows = readCsv(path.join(LOG_DIR, "bid_decisions_outcomes.csv"));
  const simRows = readCsv(path.join(LOG_DIR, "simulated_trades.csv"));

  const live = [];
  for (const row of decisionRows) {
    const ts = row.timestamp || row.resolved_at;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;

    const conf = row.confidence_score;
    const confSwing = row.confidence_swing_mean_abs_30s;
    const taPredict = row.ta_predict_score;
    const taPredictSwing = row.ta_predict_swing_mean_abs_30s;
    live.push({
      kind: "live",
      timestamp: ts,
      status: row.status,
      decisionType: row.decision_type || (row.status === "ok" ? "made" : "skipped"),
      reason: row.reason || "",
      side: row.side,
      amountUsd: row.amount_usd,
      priceToBeat: row.price_to_beat,
      finalPrice: row.final_price,
      confidence: conf === "" ? null : Number(conf),
      confidenceSwingMeanAbs30s: confSwing === "" ? null : Number(confSwing),
      taPredictScore: taPredict === "" ? null : Number(taPredict),
      taPredictSwingMeanAbs30s: taPredictSwing === "" ? null : Number(taPredictSwing),
      orderId: row.order_id || "",
      outcome: row.outcome || "PENDING",
      tokenId: row.token_id || null,
      marketSlug: row.market_slug || null
    });
  }

  const simulated = [];
  for (const row of simRows) {
    const ts = row.settled_at || row.entry_time;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    simulated.push({
      kind: "simulated",
      settledAt: row.settled_at,
      marketSlug: row.market_slug,
      side: row.side,
      entryPrice: row.entry_price_usd,
      costUsd: row.cost_usd,
      correct: row.correct,
      confidenceScore: row.confidence_score === "" ? null : Number(row.confidence_score),
      confidenceDirection: row.confidence_direction,
      pnlUsd: row.pnl_usd
    });
  }

  live.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  simulated.sort((a, b) => String(a.settledAt).localeCompare(String(b.settledAt)));

  res.json({
    range: { fromMs, toMs },
    live,
    simulated,
    resolutionNote:
      "Live outcomes use Gamma /markets?clob_token_ids=… when markets are resolved (see outcome_resolution_cache.json)."
  });
});

setInterval(refreshCache, 20_000);
refreshCache();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard: http://localhost:${PORT}/  (logs: ${LOG_DIR})`);
});
