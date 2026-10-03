/**
 * Paper-trading ledger shared by all market modules: per-module bankroll, open positions, settlement,
 * CSV logs and a JSON state file so restarts (pm2) don't lose open positions.
 */
import fs from "node:fs";
import path from "node:path";
import { appendCsvRow, ensureDir } from "../utils.js";
import { allInPricePerShare, settleBinaryPosition, simulateTakerBuy } from "../simulation/fills.js";
import { bestPrice } from "./gamma.js";

export const LOG_DIR = process.env.MARKETS_LOG_DIR || "./logs";
const STATE_FILE = () => path.join(LOG_DIR, "markets_state.json");

const fmt = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "" : Number(x).toFixed(d));
export const metaString = (meta) => Object.entries(meta ?? {}).map(([k, v]) => `${k}=${v ?? ""}`).join(";");

/**
 * Pure entry rule. Take the side (YES/NO) whose all-in best ask (price + taker fee) is furthest below the
 * model probability, if that gap ≥ minEdge. Walk the book only while each level still clears minEdge.
 */
export function decideEntry({ p, yesAsks, noAsks, feeSchedule, minEdge, betUsd, minPrice = 0.03, maxPriceCap = 0.97 }) {
  const sides = [
    { side: "YES", prob: p, asks: yesAsks },
    { side: "NO", prob: 1 - p, asks: noAsks }
  ].map((s) => {
    const ask = bestPrice(s.asks, "ask");
    const allIn = ask === null ? null : allInPricePerShare(ask, feeSchedule);
    return { ...s, ask, edge: allIn === null ? null : s.prob - allIn };
  });
  const best = sides
    .filter((s) => s.edge !== null)
    .sort((a, b) => b.edge - a.edge)[0];
  if (!best) return { action: "skip", reason: "no_asks", sides };
  if (best.edge < minEdge) return { action: "skip", reason: "edge_below_min", best, sides };
  if (best.ask < minPrice) return { action: "skip", reason: "price_below_min", best, sides };

  // Highest price on a 0.001 grid that still clears minEdge after fees
  let limit = null;
  for (let x = Math.min(maxPriceCap, 0.999); x >= best.ask - 1e-9; x -= 0.001) {
    if (best.prob - allInPricePerShare(x, feeSchedule) >= minEdge) {
      limit = Number(x.toFixed(3));
      break;
    }
  }
  if (limit === null) return { action: "skip", reason: "price_above_cap", best, sides };
  const fill = simulateTakerBuy({ asks: best.asks, budgetUsd: betUsd, maxPrice: limit, feeSchedule });
  if (fill.status !== "filled" && fill.status !== "partial") return { action: "skip", reason: fill.status, best, sides };
  return { action: "enter", side: best.side, prob: best.prob, edge: best.edge, limit, fill, sides };
}

export function createLedger({ modules, budgetUsd }) {
  ensureDir(LOG_DIR);
  let state = {
    version: 1,
    startedAt: new Date().toISOString(),
    modules: {},
    positions: [],
    watch: {},
    resolved: {}
  };
  try {
    if (fs.existsSync(STATE_FILE())) state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) };
  } catch {
    // start fresh on corrupt state
  }
  for (const name of modules) {
    state.modules[name] ??= {
      balanceUsd: budgetUsd,
      startBudgetUsd: budgetUsd,
      realizedPnlUsd: 0,
      feesUsd: 0,
      trades: 0,
      settled: 0,
      wins: 0
    };
  }

  function save() {
    // Drop resolutions older than 14 days to keep the file small
    const cutoff = Date.now() - 14 * 86_400_000;
    for (const [id, r] of Object.entries(state.resolved)) if (r.atMs < cutoff) delete state.resolved[id];
    const tmp = `${STATE_FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE_FILE());
  }

  function hasPosition(marketId) {
    return state.positions.some((p) => p.marketId === marketId);
  }

  function openCount(moduleName, eventSlug = null) {
    return state.positions.filter((p) => p.module === moduleName && (eventSlug === null || p.eventSlug === eventSlug)).length;
  }

  function open({ moduleName, market, decision, pModel, meta, nowMs = Date.now() }) {
    const m = state.modules[moduleName];
    const f = decision.fill;
    if (!m || m.balanceUsd < f.totalUsd) return null;
    m.balanceUsd -= f.totalUsd;
    m.feesUsd += f.feeUsd;
    m.trades += 1;
    const pos = {
      module: moduleName,
      marketId: market.id,
      eventSlug: market.eventSlug,
      slug: market.slug,
      question: market.question,
      side: decision.side,
      tokenId: decision.side === "YES" ? market.yesTokenId : market.noTokenId,
      shares: f.shares,
      avgPrice: f.avgPrice,
      bestAsk: f.bestAsk,
      feeUsd: f.feeUsd,
      totalUsd: f.totalUsd,
      pModel,
      edge: decision.edge,
      openedAtMs: nowMs,
      expiryMs: market.endMs
    };
    state.positions.push(pos);
    appendCsvRow(path.join(LOG_DIR, "markets_trades.csv"), [
      "timestamp", "module", "market_id", "event_slug", "slug", "question", "side", "p_model_yes", "p_side", "edge",
      "best_ask", "limit_price", "avg_price", "shares", "cost_usd", "fee_usd", "total_usd", "fill_status", "hours_to_expiry", "meta"
    ], [
      new Date(nowMs).toISOString(), moduleName, market.id, market.eventSlug, market.slug, market.question, decision.side,
      fmt(pModel), fmt(decision.prob), fmt(decision.edge), fmt(f.bestAsk), fmt(decision.limit), fmt(f.avgPrice), fmt(f.shares),
      fmt(f.costUsd), fmt(f.feeUsd), fmt(f.totalUsd), f.status, fmt((market.endMs - nowMs) / 3_600_000, 2), metaString(meta)
    ]);
    watch(moduleName, market);
    return pos;
  }

  function watch(moduleName, market) {
    if (state.resolved[market.id] || state.watch[market.id]) return;
    state.watch[market.id] = { module: moduleName, slug: market.slug, expiryMs: market.endMs, lastCheckMs: 0 };
  }

  /** Market ids past expiry whose resolution should be polled now. */
  function dueForResolution(nowMs = Date.now(), { graceMs = 5 * 60_000, recheckMs = 10 * 60_000, limit = 40 } = {}) {
    return Object.entries(state.watch)
      .filter(([, w]) => w.expiryMs + graceMs < nowMs && nowMs - w.lastCheckMs > recheckMs)
      .sort((a, b) => a[1].expiryMs - b[1].expiryMs)
      .slice(0, limit)
      .map(([id, w]) => ({ id, ...w }));
  }

  function markChecked(marketId, nowMs = Date.now()) {
    if (state.watch[marketId]) state.watch[marketId].lastCheckMs = nowMs;
    // Give up on markets unresolved 10 days after expiry (disputed / voided)
    const w = state.watch[marketId];
    if (w && nowMs - w.expiryMs > 10 * 86_400_000) delete state.watch[marketId];
  }

  function resolve(marketId, yesWon, nowMs = Date.now()) {
    const w = state.watch[marketId];
    delete state.watch[marketId];
    state.resolved[marketId] = { yesWon, atMs: nowMs };
    appendCsvRow(path.join(LOG_DIR, "markets_resolutions.csv"), ["timestamp", "module", "market_id", "slug", "yes_won"], [
      new Date(nowMs).toISOString(), w?.module ?? "", marketId, w?.slug ?? "", String(yesWon)
    ]);
    const settled = [];
    state.positions = state.positions.filter((pos) => {
      if (pos.marketId !== marketId) return true;
      const won = pos.side === "YES" ? yesWon : !yesWon;
      const r = settleBinaryPosition({ shares: pos.shares, totalUsd: pos.totalUsd, won });
      const m = state.modules[pos.module];
      if (m) {
        m.balanceUsd += r.payoutUsd;
        m.realizedPnlUsd += r.pnlUsd;
        m.settled += 1;
        if (won) m.wins += 1;
      }
      appendCsvRow(path.join(LOG_DIR, "markets_settlements.csv"), [
        "timestamp", "module", "market_id", "slug", "question", "side", "yes_won", "won", "p_model_yes", "edge_at_entry",
        "avg_price", "shares", "total_usd", "fee_usd", "payout_usd", "pnl_usd"
      ], [
        new Date(nowMs).toISOString(), pos.module, marketId, pos.slug, pos.question, pos.side, String(yesWon), String(won),
        fmt(pos.pModel), fmt(pos.edge), fmt(pos.avgPrice), fmt(pos.shares), fmt(pos.totalUsd), fmt(pos.feeUsd), fmt(r.payoutUsd), fmt(r.pnlUsd)
      ]);
      settled.push({ ...pos, won, ...r });
      return false;
    });
    return settled;
  }

  function summary() {
    return Object.entries(state.modules).map(([name, m]) => {
      const open = state.positions.filter((p) => p.module === name);
      return {
        module: name,
        ...m,
        openPositions: open.length,
        openExposureUsd: open.reduce((a, p) => a + p.totalUsd, 0),
        watching: Object.values(state.watch).filter((w) => w.module === name).length
      };
    });
  }

  return { state: () => state, save, hasPosition, openCount, open, watch, dueForResolution, markChecked, resolve, summary };
}
