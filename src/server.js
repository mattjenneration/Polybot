import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { errorToRedactedLogString } from "./logRedact.js";
import { getUsdcBalanceUsd } from "./trading/polymarketTrade.js";

process.on("unhandledRejection", (reason) => {
  console.error("[btc-dashboard] Unhandled rejection:", errorToRedactedLogString(reason));
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? "3000");
const LOG_DIR = path.resolve(process.cwd(), "logs");
const DASHBOARD_JSON = path.join(LOG_DIR, "dashboard.json");
const SIM_CONTROL_FILE = path.join(LOG_DIR, "sim_controls.json");
const DASHBOARD_SECRET = (process.env.DASHBOARD_SECRET || "").trim();

const app = express();
app.use(express.json({ limit: "8kb" }));
app.use(express.static(__dirname, { index: "index.html" }));

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else if (c === '"') inQ = true;
    else cur += c;
  }
  out.push(cur);
  return out;
}

function tailCsv(filePath, limit) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(Math.max(1, lines.length - limit)).reverse().map((l) => {
    const cells = parseCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

let walletCache = { at: 0, value: null };
async function walletBalance() {
  if (!CONFIG.polymarket.funderAddress) return null;
  if (Date.now() - walletCache.at < 30_000) return walletCache.value;
  try {
    walletCache = { at: Date.now(), value: await getUsdcBalanceUsd() };
  } catch {
    walletCache = { at: Date.now(), value: null };
  }
  return walletCache.value;
}

app.get("/api/state", async (req, res) => {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(DASHBOARD_JSON, "utf8"));
  } catch {
    // bot not running yet
  }
  res.json({ state, wallet: await walletBalance(), resetProtected: Boolean(DASHBOARD_SECRET) });
});

app.get("/api/trades", (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 100));
  res.json({
    sim: tailCsv(path.resolve(CONFIG.sim.tradesCsv), limit),
    live: tailCsv(path.join(LOG_DIR, "live_trades.csv"), limit)
  });
});

app.post("/api/sim-reset", (req, res) => {
  if (DASHBOARD_SECRET) {
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (bearer !== DASHBOARD_SECRET && req.body?.secret !== DASHBOARD_SECRET) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const payload = { resetRequestedAt: new Date().toISOString() };
    fs.writeFileSync(SIM_CONTROL_FILE, JSON.stringify(payload), "utf8");
    res.json({ ok: true, ...payload });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Dashboard: http://${HOST}:${PORT}/  (logs: ${LOG_DIR})`);
});
