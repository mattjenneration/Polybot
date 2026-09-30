function envNum(name, fallback, min = -Infinity, max = Infinity) {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
}

function envList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export const CONFIG = {
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",
  binanceSymbol: (process.env.BINANCE_SYMBOL || "btcusdt").toLowerCase(),

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10684",
    autoSelectLatest: envBool("POLYMARKET_AUTO_SELECT_LATEST", true),
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down",
    funderAddress: (process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLY_FUNDER_ADDRESS || "").trim(),
    // 0 = EOA, 1 = POLY_PROXY, 2 = GNOSIS_SAFE (see Polymarket docs)
    signatureType: envNum("POLY_SIGNATURE_TYPE", 2)
  },

  chainlink: {
    // Only used by the live-order client (ethers provider for balance reads).
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com"
  },

  loop: {
    tickMs: envNum("TICK_MS", 1000, 250, 10_000),
    bookPollMs: envNum("BOOK_POLL_MS", 1000, 250, 10_000),
    marketPollMs: envNum("MARKET_POLL_MS", 5000, 1000, 60_000)
  },

  feeds: {
    // Any price older than this is treated as missing: no decisions are made on stale data.
    maxChainlinkAgeMs: envNum("MAX_CHAINLINK_AGE_MS", 5000, 500, 60_000),
    maxBinanceAgeMs: envNum("MAX_BINANCE_AGE_MS", 3000, 500, 60_000),
    maxBookAgeMs: envNum("MAX_BOOK_AGE_MS", 3000, 500, 60_000)
  },

  rounds: {
    // Price-to-beat is latched from the first Chainlink tick stamped within this many ms after the round start.
    ptbLatchToleranceMs: envNum("PTB_LATCH_TOLERANCE_MS", 3000, 0, 30_000),
    resolutionPollMs: envNum("RESOLUTION_POLL_MS", 15_000, 2000, 300_000),
    resolutionGiveUpMs: envNum("RESOLUTION_GIVE_UP_MS", 3 * 3600_000, 60_000, 48 * 3600_000)
  },

  sim: {
    startingBankrollUsd: envNum("SIM_BANKROLL_USD", 100, 1, 1e9),
    // Taker orders fill against the first book snapshot at least this long after the decision.
    latencyMs: envNum("SIM_LATENCY_MS", 400, 0, 10_000),
    // Comma-separated strategy ids, or "all".
    strategies: envList("SIM_STRATEGIES", ["all"]),
    stateFile: process.env.SIM_STATE_FILE || "./logs/sim_state.json",
    tradesCsv: process.env.SIM_TRADES_CSV || "./logs/sim_trades.csv",
    record: envBool("RECORD_DATA", true),
    recordingsDir: process.env.RECORDINGS_DIR || "./logs/recordings",
    bookDepth: envNum("BOOK_DEPTH", 10, 1, 50)
  },

  learner: {
    learningRate: envNum("LEARNER_LR", 0.05, 0.0001, 1),
    l2: envNum("LEARNER_L2", 0.01, 0, 1),
    // One training sample per round per this many seconds of the decision window.
    sampleEverySec: envNum("LEARNER_SAMPLE_EVERY_SEC", 15, 1, 300),
    sampleWindowSec: envNum("LEARNER_SAMPLE_WINDOW_SEC", 240, 10, 300)
  },

  trading: {
    enableLiveTrading: envBool("ENABLE_LIVE_TRADING", false),
    // Which simulated strategy the live bot mirrors (see src/strategy/strategies.js).
    liveStrategy: process.env.LIVE_STRATEGY || "conservative",
    // Hard caps for live orders, independent of the strategy's own sizing.
    maxLiveStakeUsd: envNum("MAX_LIVE_STAKE_USD", 5, 1, 10_000),
    dailyLossLimitUsd: envNum("DAILY_LOSS_LIMIT_USD", 25, 0, 1e9),
    // Live mirroring only starts once the strategy has this many settled sim bets with positive P&L.
    liveMinSimBets: envNum("LIVE_MIN_SIM_BETS", 200, 0, 1e6),
    privateKey: process.env.PRIVATE_KEY || "",
    usdcAddress: process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    chainId: 137,
    debugLiveTrading: envBool("DEBUG_LIVE_TRADING", false),
    // FAK = fill what's available (partial ok), FOK = fill entire amount or cancel
    marketOrderType: (process.env.MARKET_ORDER_TYPE || "FAK").toUpperCase() === "FOK" ? "FOK" : "FAK"
  },

  console: {
    quiet: envBool("QUIET_CONSOLE", false)
  }
};
