export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 2_000,
  candleWindowMinutes: 5,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10684",
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-5m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down",
    funderAddress: (process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLY_FUNDER_ADDRESS || "").trim(),
    // 0 = EOA, 1 = POLY_PROXY, 2 = GNOSIS_SAFE (see Polymarket docs)
    signatureType: Number(process.env.POLY_SIGNATURE_TYPE ?? "2")
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://rpc.ankr.com/polygon",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  },

  trading: {
    timeframe: process.env.BOT_TIMEFRAME || "5m",
    tradeThreshold: Number(process.env.TRADE_THRESHOLD ?? "75"),
    positionSizeUsd: Number(process.env.POSITION_SIZE_USD ?? "10"),
    cooldownMinutes: Number(process.env.COOLDOWN_MINUTES ?? "15"),
    enableLiveTrading: (process.env.ENABLE_LIVE_TRADING || "false").toLowerCase() === "true",
    privateKey: process.env.PRIVATE_KEY || "",
    usdcAddress: process.env.USDC_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    chainId: 137,
    simBudgetUsd: Number(process.env.BUDGET_USD ?? "0"),
    simBetAmountUsd: Number(process.env.BET_AMOUNT_USD ?? "0"),
    debugLiveTrading: (process.env.DEBUG_LIVE_TRADING || "false").toLowerCase() === "true"
  }
};
