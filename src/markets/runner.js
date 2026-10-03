/**
 * Multi-market paper-trading simulator (crypto price ladders + weather), run alongside the BTC 5m bot.
 *   npm run sim:markets
 * Every loop: discover markets → model probability → log calibration snapshot → paper-take mispriced
 * outcomes from the real order book (with taker fees) → settle resolved markets from Gamma.
 * Analyse with: npm run report:markets
 */
import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import { appendCsvRow, sleep } from "../utils.js";
import { errorToRedactedLogString } from "../logRedact.js";
import { getFeeSchedule } from "../simulation/fills.js";
import { fetchMarketsByTag, fetchBooks, fetchResolution } from "./gamma.js";
import { createCryptoLadderModule } from "./cryptoLadder.js";
import { createWeatherModule } from "./weather.js";
import { createLedger, decideEntry, metaString, LOG_DIR } from "./paperLedger.js";

const num = (name, def) => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(n) ? n : def;
};
const list = (name, def) => (process.env[name] ? process.env[name].split(",").map((s) => s.trim()).filter(Boolean) : def);

const CFG = {
  loopMs: num("MARKETS_LOOP_SECONDS", 60) * 1000,
  snapshotMs: num("MARKETS_SNAPSHOT_MINUTES", 15) * 60_000,
  budgetUsd: num("MARKETS_BUDGET_USD", 1000),
  betUsd: num("MARKETS_BET_USD", 10),
  maxOpenPerModule: num("MARKETS_MAX_OPEN_POSITIONS", 60),
  maxOpenPerEvent: num("MARKETS_MAX_POSITIONS_PER_EVENT", 3),
  modules: list("MARKETS_MODULES", ["crypto_ladder", "weather"]),
  crypto: {
    minEdge: num("CRYPTO_LADDER_MIN_EDGE", 0.06),
    minMinutesToExpiry: num("CRYPTO_LADDER_MIN_MINUTES_TO_EXPIRY", 15),
    assets: list("CRYPTO_LADDER_ASSETS", ["BTC", "ETH", "SOL", "XRP"]),
    tags: list("CRYPTO_LADDER_TAGS", ["crypto"]),
    maxDays: num("CRYPTO_LADDER_MAX_DAYS", 35)
  },
  weather: {
    minEdge: num("WEATHER_MIN_EDGE", 0.08),
    minMinutesToExpiry: num("WEATHER_MIN_MINUTES_TO_EXPIRY", 0),
    tags: list("WEATHER_TAGS", ["weather"]),
    maxDays: num("WEATHER_MAX_DAYS", 4)
  }
};

const log = (...a) => console.log(`[markets ${new Date().toISOString()}]`, ...a);

export function buildModules() {
  const mods = [];
  if (CFG.modules.includes("crypto_ladder")) {
    mods.push({ ...createCryptoLadderModule(CFG.crypto), cfg: CFG.crypto });
  }
  if (CFG.modules.includes("weather")) {
    mods.push({ ...createWeatherModule(CFG.weather), cfg: CFG.weather });
  }
  return mods;
}

async function discover(mod) {
  const byId = new Map();
  for (const tag of mod.tags) {
    try {
      for (const m of await fetchMarketsByTag(tag, { endWithinMs: mod.endWithinMs })) byId.set(m.id, m);
    } catch (err) {
      log(`${mod.name}: discovery failed for tag "${tag}": ${errorToRedactedLogString(err)}`);
    }
  }
  return [...byId.values()];
}

export async function runModule(mod, ledger, lastSnapshotAt, nowMs) {
  const markets = await discover(mod);
  const items = [];
  let unparsed = 0;
  for (const market of markets) {
    if (!market.acceptingOrders || !market.endMs) continue;
    if (market.endMs - nowMs < mod.cfg.minMinutesToExpiry * 60_000) continue;
    const spec = mod.parse(market);
    if (spec) items.push({ market, spec });
    else unparsed += 1;
  }
  const priced = await mod.priceAll(items, nowMs);
  const feeSchedule = getFeeSchedule(mod.feeCategory);

  // Calibration snapshots (independent of trading thresholds) + resolution watch
  for (const { market } of items) {
    const pr = priced.get(market.id);
    if (!pr) continue;
    ledger.watch(mod.name, market);
    if (nowMs - (lastSnapshotAt.get(market.id) ?? 0) < CFG.snapshotMs) continue;
    lastSnapshotAt.set(market.id, nowMs);
    appendCsvRow(path.join(LOG_DIR, "markets_snapshots.csv"), [
      "timestamp", "module", "market_id", "event_slug", "slug", "question", "hours_to_expiry", "p_model_yes",
      "gamma_best_bid", "gamma_best_ask", "liquidity", "volume_24h", "meta"
    ], [
      new Date(nowMs).toISOString(), mod.name, market.id, market.eventSlug, market.slug, market.question,
      ((market.endMs - nowMs) / 3_600_000).toFixed(2), pr.p.toFixed(4), market.bestBid ?? "", market.bestAsk ?? "",
      market.liquidity.toFixed(0), market.volume24hr.toFixed(0), metaString(pr.meta)
    ]);
  }

  // Pre-filter with Gamma top-of-book before pulling full books
  const candidates = items.filter(({ market }) => {
    const pr = priced.get(market.id);
    if (!pr || ledger.hasPosition(market.id)) return false;
    if (market.bestAsk === null || market.bestBid === null) return true;
    const yesEdge = pr.p - market.bestAsk;
    const noEdge = (1 - pr.p) - (1 - market.bestBid);
    return Math.max(yesEdge, noEdge) >= mod.cfg.minEdge / 2;
  });

  let entered = 0;
  if (candidates.length) {
    const books = await fetchBooks(candidates.flatMap(({ market }) => [market.yesTokenId, market.noTokenId]));
    // Biggest model-vs-market gaps first, so position caps keep the best opportunities
    candidates.sort((a, b) => {
      const ga = Math.abs(priced.get(a.market.id).p - (a.market.bestAsk ?? 0.5));
      const gb = Math.abs(priced.get(b.market.id).p - (b.market.bestAsk ?? 0.5));
      return gb - ga;
    });
    for (const { market } of candidates) {
      if (ledger.openCount(mod.name) >= CFG.maxOpenPerModule) break;
      if (ledger.openCount(mod.name, market.eventSlug) >= CFG.maxOpenPerEvent) continue;
      const pr = priced.get(market.id);
      const decision = decideEntry({
        p: pr.p,
        yesAsks: books.get(market.yesTokenId)?.asks,
        noAsks: books.get(market.noTokenId)?.asks,
        feeSchedule,
        minEdge: mod.cfg.minEdge,
        betUsd: CFG.betUsd
      });
      if (decision.action !== "enter") continue;
      const pos = ledger.open({ moduleName: mod.name, market, decision, pModel: pr.p, meta: pr.meta, nowMs });
      if (pos) {
        entered += 1;
        log(`${mod.name} BUY ${pos.side} "${market.question}" p_yes=${pr.p.toFixed(3)} edge=${decision.edge.toFixed(3)} `
          + `avg=${pos.avgPrice.toFixed(3)} $${pos.totalUsd.toFixed(2)} (fee $${pos.feeUsd.toFixed(3)})`);
      }
    }
  }
  return { discovered: markets.length, parsed: items.length, unparsed, priced: priced.size, candidates: candidates.length, entered };
}

export async function settle(ledger, nowMs) {
  for (const w of ledger.dueForResolution(nowMs)) {
    try {
      const r = await fetchResolution(w.id);
      if (r.resolved) {
        for (const s of ledger.resolve(w.id, r.yesWon, nowMs)) {
          log(`${s.module} SETTLED ${s.side} "${s.question}" ${s.won ? "WON" : "LOST"} pnl=$${s.pnlUsd.toFixed(2)}`);
        }
      } else {
        ledger.markChecked(w.id, nowMs);
      }
    } catch (err) {
      ledger.markChecked(w.id, nowMs);
      log(`resolution check failed for ${w.slug}: ${errorToRedactedLogString(err)}`);
    }
  }
}

async function main() {
  applyGlobalProxyFromEnv();
  const mods = buildModules();
  const ledger = createLedger({ modules: mods.map((m) => m.name), budgetUsd: CFG.budgetUsd });
  const lastSnapshotAt = new Map();
  log(`starting modules=${mods.map((m) => m.name).join(",")} bet=$${CFG.betUsd} budget=$${CFG.budgetUsd} loop=${CFG.loopMs / 1000}s`);

  for (;;) {
    const started = Date.now();
    for (const mod of mods) {
      try {
        const st = await runModule(mod, ledger, lastSnapshotAt, Date.now());
        log(`${mod.name}: discovered=${st.discovered} parsed=${st.parsed} priced=${st.priced} candidates=${st.candidates} entered=${st.entered}`);
      } catch (err) {
        log(`${mod.name}: loop error ${errorToRedactedLogString(err)}`);
      }
    }
    try {
      await settle(ledger, Date.now());
    } catch (err) {
      log(`settle error ${errorToRedactedLogString(err)}`);
    }
    for (const s of ledger.summary()) {
      log(`${s.module}: bal=$${s.balanceUsd.toFixed(2)} realized=$${s.realizedPnlUsd.toFixed(2)} fees=$${s.feesUsd.toFixed(2)} `
        + `trades=${s.trades} settled=${s.settled} wins=${s.wins} open=${s.openPositions} ($${s.openExposureUsd.toFixed(2)}) watching=${s.watching}`);
    }
    try {
      ledger.save();
    } catch (err) {
      log(`state save failed: ${errorToRedactedLogString(err)}`);
    }
    await sleep(Math.max(5_000, CFG.loopMs - (Date.now() - started)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[markets] fatal:", errorToRedactedLogString(err));
    process.exit(1);
  });
}
