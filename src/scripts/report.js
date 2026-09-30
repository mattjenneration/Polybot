/**
 * Break down settled simulated trades (logs/sim_trades.csv, or a backtest's trades.csv).
 *
 *   npm run report                        # all trades
 *   npm run report -- --hours 24
 *   npm run report -- --file logs/backtests/<run>/trades.csv --strategy balanced
 */
import "dotenv/config";
import fs from "node:fs";
import { CONFIG } from "../config.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])));
}

function group(rows, keyFn) {
  const out = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

function stats(rows) {
  const cost = rows.reduce((a, r) => a + Number(r.cost_usd), 0);
  const pnl = rows.reduce((a, r) => a + Number(r.pnl_usd), 0);
  const wins = rows.filter((r) => Number(r.pnl_usd) > 0).length;
  const fees = rows.reduce((a, r) => a + Number(r.fee_usd || 0), 0);
  return { n: rows.length, winRate: rows.length ? wins / rows.length : 0, pnl, fees, retPerDollar: cost ? pnl / cost : 0 };
}

function table(title, groups) {
  console.log(`\n${title}`);
  console.log(`${"".padEnd(22)}${"bets".padStart(6)}${"win%".padStart(8)}${"P&L".padStart(11)}${"fees".padStart(9)}${"ret/$".padStart(9)}`);
  for (const [k, rows] of [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const s = stats(rows);
    console.log(`${String(k).padEnd(22)}${String(s.n).padStart(6)}${(s.winRate * 100).toFixed(1).padStart(7)}%${s.pnl.toFixed(2).padStart(11)}${s.fees.toFixed(2).padStart(9)}${(s.retPerDollar * 100).toFixed(2).padStart(8)}%`);
  }
}

const file = arg("file", CONFIG.sim.tradesCsv);
if (!fs.existsSync(file)) {
  console.error(`No trades file at ${file}`);
  process.exit(1);
}
let rows = readCsv(file);
const hours = Number(arg("hours", 0));
if (hours > 0) {
  const cutoff = Date.now() - hours * 3600_000;
  rows = rows.filter((r) => new Date(r.settled_at).getTime() >= cutoff);
}
const only = arg("strategy");
if (only) rows = rows.filter((r) => r.strategy === only);

console.log(`${rows.length} settled trades from ${file}${hours ? ` (last ${hours}h)` : ""}`);
table("By strategy", group(rows, (r) => r.strategy));
table("By entry price", group(rows, (r) => {
  const p = Number(r.avg_price);
  const lo = Math.min(0.9, Math.floor(p * 10) / 10);
  return `${lo.toFixed(1)}–${(lo + 0.1).toFixed(1)}`;
}));
table("By seconds left at entry", group(rows, (r) => {
  const s = Number(r.seconds_left);
  const b = s < 30 ? "000–030" : s < 60 ? "030–060" : s < 120 ? "060–120" : s < 180 ? "120–180" : "180–300";
  return b;
}));
table("By side", group(rows, (r) => r.side));
table("By UTC hour", group(rows, (r) => String(new Date(r.settled_at).getUTCHours()).padStart(2, "0")));
