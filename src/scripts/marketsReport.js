/**
 * Side-by-side scorecard: BTC 5m strategy lab vs crypto ladders vs weather.
 *   npm run report:markets            (all time)
 *   npm run report:markets -- --hours 24
 *
 * Per market: trades, win rate, P&L after fees, ROI on capital spent, fees paid.
 * Calibration (ladders/weather): Brier score of the model vs the market's own mid price on the same
 * snapshots, once those markets resolve. Model Brier < market Brier ⇒ the model knows something the
 * price doesn't. If it isn't lower, P&L is luck.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), process.env.MARKETS_LOG_DIR || "logs");

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

function readCsv(file) {
  const p = path.join(LOG_DIR, file);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

const args = process.argv.slice(2);
const hoursIdx = args.indexOf("--hours");
const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : null;
const sinceMs = Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3_600_000 : 0;
const inWindow = (r, key) => !sinceMs || new Date(r[key]).getTime() >= sinceMs;
const n = (x) => (x === "" || x === undefined ? null : Number(x));
const usd = (x) => `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;
const pct = (x) => (x === null || !Number.isFinite(x) ? "-" : `${(x * 100).toFixed(1)}%`);

const rows = [];

// BTC 5m strategy lab (one row per strategy; cost_usd already includes the taker fee)
const btc = readCsv(path.basename(process.env.SIM_TRADES_CSV || "sim_trades.csv")).filter((r) => inWindow(r, "settled_at"));
const byStrategy = new Map();
for (const r of btc) {
  const s = byStrategy.get(r.strategy) ?? { trades: 0, wins: 0, pnl: 0, spent: 0, fees: 0 };
  s.trades += 1;
  if (r.won === "true") s.wins += 1;
  s.pnl += n(r.pnl_usd) ?? 0;
  s.spent += n(r.cost_usd) ?? 0;
  s.fees += n(r.fee_usd) ?? 0;
  byStrategy.set(r.strategy, s);
}
for (const [strategy, s] of byStrategy) {
  rows.push({
    market: `btc_5m:${strategy}`,
    trades: s.trades,
    winRate: s.wins / s.trades,
    pnl: s.pnl,
    roi: s.spent > 0 ? s.pnl / s.spent : null,
    fees: s.fees,
    avgEdge: null
  });
}

// Ladders / weather
const settlements = readCsv("markets_settlements.csv").filter((r) => inWindow(r, "timestamp"));
const trades = readCsv("markets_trades.csv").filter((r) => inWindow(r, "timestamp"));
for (const mod of [...new Set([...settlements, ...trades].map((r) => r.module))]) {
  const st = settlements.filter((r) => r.module === mod);
  const tr = trades.filter((r) => r.module === mod);
  const spent = st.reduce((a, r) => a + (n(r.total_usd) ?? 0), 0);
  const pnl = st.reduce((a, r) => a + (n(r.pnl_usd) ?? 0), 0);
  rows.push({
    market: `${mod} (${tr.length} opened, ${tr.length - st.length} open)`,
    trades: st.length,
    winRate: st.length ? st.filter((r) => r.won === "true").length / st.length : null,
    pnl,
    roi: spent > 0 ? pnl / spent : null,
    fees: st.reduce((a, r) => a + (n(r.fee_usd) ?? 0), 0),
    avgEdge: tr.length ? tr.reduce((a, r) => a + (n(r.edge) ?? 0), 0) / tr.length : null
  });
}

console.log(`\nP&L scorecard${hours ? ` (last ${hours}h)` : ""} — settled trades only, after taker fees\n`);
console.log(["market".padEnd(44), "settled".padStart(8), "win%".padStart(7), "pnl".padStart(11), "roi".padStart(8), "fees".padStart(9), "avg edge".padStart(9)].join(" "));
for (const r of rows) {
  console.log([
    r.market.padEnd(44), String(r.trades).padStart(8), pct(r.winRate).padStart(7), usd(r.pnl).padStart(11),
    pct(r.roi).padStart(8), `$${r.fees.toFixed(2)}`.padStart(9), pct(r.avgEdge).padStart(9)
  ].join(" "));
}
if (!rows.length) console.log("(no settled trades yet)");

// Calibration: model vs market mid on resolved snapshots
const resolved = new Map(readCsv("markets_resolutions.csv").map((r) => [r.market_id, r.yes_won === "true"]));
const snaps = readCsv("markets_snapshots.csv").filter((r) => inWindow(r, "timestamp") && resolved.has(r.market_id));
const cal = new Map();
for (const s of snaps) {
  const bid = n(s.gamma_best_bid);
  const ask = n(s.gamma_best_ask);
  const pm = n(s.p_model_yes);
  if (bid === null || ask === null || pm === null || ask < bid) continue;
  const mid = (bid + ask) / 2;
  const y = resolved.get(s.market_id) ? 1 : 0;
  const h = n(s.hours_to_expiry);
  const horizon = h < 6 ? "<6h" : h < 24 ? "6-24h" : h < 72 ? "1-3d" : ">3d";
  for (const key of [`${s.module} all`, `${s.module} ${horizon}`]) {
    const c = cal.get(key) ?? { n: 0, model: 0, market: 0, markets: new Set() };
    c.n += 1;
    c.model += (pm - y) ** 2;
    c.market += (mid - y) ** 2;
    c.markets.add(s.market_id);
    cal.set(key, c);
  }
}
console.log("\nCalibration — Brier score (lower is better) on resolved markets\n");
console.log(["slice".padEnd(28), "snaps".padStart(7), "markets".padStart(8), "model".padStart(8), "market".padStart(8), "model edge".padStart(11)].join(" "));
for (const [key, c] of [...cal.entries()].sort()) {
  const bm = c.model / c.n;
  const bk = c.market / c.n;
  console.log([key.padEnd(28), String(c.n).padStart(7), String(c.markets.size).padStart(8), bm.toFixed(4).padStart(8), bk.toFixed(4).padStart(8), `${bk > bm ? "+" : ""}${(bk - bm).toFixed(4)}`.padStart(11)].join(" "));
}
if (!cal.size) console.log("(no resolved snapshots yet — needs markets to expire)");
console.log("");
