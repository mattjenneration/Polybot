/**
 * Weather trader report from logs/weather/dashboard.json (works over SSH, no browser):
 *   npm run report:weather
 * Strategy leaderboard, what learning mode has found (timing, cities, variants, model vs market), and a
 * go-live checklist.
 */
import fs from "node:fs";
import path from "node:path";
import { WCFG } from "./config.js";

const file = path.join(WCFG.logDir, "dashboard.json");
if (!fs.existsSync(file)) {
  console.log(`No ${file} yet — start the weather trader: npm run sim:weather`);
  process.exit(0);
}
const st = JSON.parse(fs.readFileSync(file, "utf8"));
const ok = (x) => x !== null && x !== undefined && Number.isFinite(x);
const pct = (x, d = 1) => (ok(x) ? `${(x * 100).toFixed(d)}%` : "-");
const usd = (x) => (ok(x) ? `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}` : "-");
const pad = (s, n, left = false) => (left ? String(s).padEnd(n) : String(s).padStart(n));
const L = st.sim.learning;
const sc = st.model.calibrator.scorecard;

console.log(`\nWeather trader — updated ${st.updatedAt} — learning mode ${st.mode.learning ? "ON" : "frozen"}`);
console.log(`${st.status.events} events tracked, ${st.status.tradeable} tradeable, ${L.settledEvents} settled, ${L.variantsProven}/${L.variantsTested} variants proven\n`);

console.log([pad("strategy", 26, true), pad("equity", 10), pad("roi", 8), pad("bets", 6), pad("events", 7), pad("win%", 7), pad("pnl", 10), pad("ret/$", 8), pad("maxDD", 7)].join(" "));
for (const s of st.sim.strategies) {
  console.log([pad(s.label, 26, true), pad(`$${s.equity.toFixed(2)}`, 10), pad(pct(s.roi), 8), pad(s.bets, 6), pad(s.events, 7), pad(pct(s.winRate), 7), pad(usd(s.pnl), 10), pad(pct(s.returnOnStaked), 8), pad(pct(s.maxDrawdown), 7)].join(" "));
}

console.log("\nModel vs market (log loss per event, lower is better)");
const line = (label, s) => (s?.n ? console.log(`  ${pad(label, 14, true)} n=${pad(s.n, 5)} weather ${s.logLoss.wx.toFixed(3)}  market ${s.logLoss.mkt.toFixed(3)}  blend ${s.logLoss.final.toFixed(3)}  edge ${(s.logLoss.mkt - s.logLoss.final).toFixed(3)}`) : null);
line("all", sc.all);
for (const [bin, s] of Object.entries(sc.byBin ?? {})) line(bin, s);
if (!sc.all?.n) console.log("  (no settled events yet)");

console.log("\nTiming windows (pooled shadow return per $)");
for (const w of L.windows) console.log(`  ${pad(w.window, 10, true)} events=${pad(w.n, 4)} ret/$=${pad(pct(w.mean), 7)} lower=${pad(pct(w.lcb), 7)}`);

const cities = [...L.cities].filter((c) => c.status !== "learning").sort((a, b) => b.mult - a.mult);
console.log("\nCities with a verdict");
if (!cities.length) console.log("  (none yet — each needs settled events)");
for (const c of cities) console.log(`  ${pad(c.key, 24, true)} ${pad(c.status, 8, true)} ×${c.mult.toFixed(2)} events=${c.n} ret/$=${pct(c.mean)}`);

console.log("\nTop variants");
for (const v of L.variants.slice(0, 8)) console.log(`  ${pad(v.label, 34, true)} events=${pad(v.n, 4)} ret/$=${pad(pct(v.mean), 7)} lower=${pct(v.lcb)}`);

// Go-live checklist: necessary, not sufficient
const learning = st.sim.strategies.find((s) => s.id === "learning");
const checks = [
  ["≥ 200 settled events", L.settledEvents >= 200, `${L.settledEvents}`],
  ["blend beats market price (log loss)", sc.all?.n >= 100 && sc.all.logLoss.final < sc.all.logLoss.mkt, sc.all?.n ? `${(sc.all.logLoss.mkt - sc.all.logLoss.final).toFixed(3)} over ${sc.all.n}` : "no data"],
  ["≥ 3 proven variants", L.variantsProven >= 3, `${L.variantsProven}`],
  ["learning strategy profitable after fees", Boolean(learning && learning.events >= 50 && learning.pnl > 0), learning ? `${usd(learning.pnl)} over ${learning.events} events` : "-"],
  ["learning strategy drawdown < 25%", Boolean(learning && learning.events >= 50 && learning.maxDrawdown < 0.25), learning ? pct(learning.maxDrawdown) : "-"],
  ["observations match official results ≥ 98%", st.status.outcomeCheck?.n >= 50 && st.status.outcomeCheck.match / st.status.outcomeCheck.n >= 0.98, st.status.outcomeCheck?.n ? `${st.status.outcomeCheck.match}/${st.status.outcomeCheck.n}` : "no data"]
];
console.log("\nGo-live checklist (necessary, not sufficient)");
for (const [label, pass, detail] of checks) console.log(`  [${pass ? "x" : " "}] ${pad(label, 42, true)} ${detail}`);
console.log("");
