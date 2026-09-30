import { appendCsvRow } from "../utils.js";
import { executeLiveBuy } from "./polymarketTrade.js";

const LIVE_CSV = "./logs/live_trades.csv";
const LIVE_HEADER = [
  "timestamp", "strategy", "market_slug", "side", "seconds_left", "p_model", "ref_price", "worst_price",
  "edge_per_share", "requested_usd", "status", "reason", "order_id", "spent_usd", "shares"
];

function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Mirrors one simulated strategy's entries with real orders.
 * Refuses to trade until that strategy has a track record in simulation, and stops for the day
 * once realized live losses hit the daily limit.
 */
export function createLiveExecutor({ config, engine }) {
  const t = config.trading;
  const positions = []; // { slug, side, spentUsd, shares }
  const daily = { day: null, realizedPnl: 0 };
  let inFlight = false;
  let lastStatus = t.enableLiveTrading ? "armed" : "off";

  function gate(intent, ctx) {
    if (!t.enableLiveTrading) return "live_disabled";
    if (intent.execution !== "taker") return "maker_not_supported_live";
    if (inFlight) return "order_in_flight";
    const stats = engine.accountStats(t.liveStrategy);
    if (!stats) return "unknown_live_strategy";
    if (stats.bets < t.liveMinSimBets) return `sim_track_record_${stats.bets}/${t.liveMinSimBets}`;
    if (!(stats.pnl > 0)) return "sim_pnl_not_positive";
    if (daily.day !== utcDay(ctx.ts)) {
      daily.day = utcDay(ctx.ts);
      daily.realizedPnl = 0;
    }
    if (t.dailyLossLimitUsd > 0 && -daily.realizedPnl >= t.dailyLossLimitUsd) return "daily_loss_limit";
    return null;
  }

  async function onIntent({ strategyId, intent, ctx, round }) {
    if (strategyId !== t.liveStrategy) return;
    const blocked = gate(intent, ctx);
    if (blocked) {
      lastStatus = blocked;
      return;
    }
    inFlight = true;
    const amountUsd = Math.min(intent.stakeUsd, t.maxLiveStakeUsd);
    const tokenId = intent.side === "UP" ? round.upTokenId : round.downTokenId;
    let res;
    try {
      res = await executeLiveBuy({ tokenId, amountUsd, worstPrice: intent.limitPrice, tickSize: round.tickSize, negRisk: round.negRisk });
    } catch (err) {
      res = { status: "error", reason: String(err?.message ?? err) };
    } finally {
      inFlight = false;
    }
    lastStatus = res.status === "ok" ? `filled ${intent.side} ${ctx.slug}` : `${res.status}: ${res.reason}`;
    if (res.status === "ok" && res.spentUsd && res.shares) {
      positions.push({ slug: ctx.slug, side: intent.side, spentUsd: res.spentUsd, shares: res.shares });
    }
    try {
      appendCsvRow(LIVE_CSV, LIVE_HEADER, [
        new Date(ctx.ts).toISOString(), strategyId, ctx.slug, intent.side, ctx.secondsLeft.toFixed(1),
        intent.pSide.toFixed(4), intent.refPrice, intent.limitPrice, intent.edgePerShare.toFixed(4),
        amountUsd.toFixed(2), res.status, res.reason ?? "", res.orderId ?? "", res.spentUsd ?? "", res.shares ?? ""
      ]);
    } catch {
      // logging must never break trading
    }
  }

  function onResolution({ slug, outcome }) {
    for (let i = positions.length - 1; i >= 0; i -= 1) {
      const p = positions[i];
      if (p.slug !== slug) continue;
      positions.splice(i, 1);
      if (outcome !== "UP" && outcome !== "DOWN") continue;
      daily.realizedPnl += (p.side === outcome ? p.shares : 0) - p.spentUsd;
    }
  }

  return {
    onIntent,
    onResolution,
    status: () => ({ enabled: t.enableLiveTrading, strategy: t.liveStrategy, lastStatus, openPositions: positions.length, dailyRealizedPnl: daily.realizedPnl })
  };
}
