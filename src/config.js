export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 2_000,
  candleWindowMinutes: 5,
  /** How much auxiliary futures + microstructure (-100..100) adds to TA confidence. */
  confidenceAuxiliaryWeight: Math.max(0, Math.min(0.45, Number(process.env.CONFIDENCE_AUXILIARY_WEIGHT ?? "0.22"))),

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
    debugLiveTrading: (process.env.DEBUG_LIVE_TRADING || "false").toLowerCase() === "true",
    // Market order type: FAK = fill what's available (partial ok), FOK = fill entire amount or cancel
    marketOrderType: (process.env.MARKET_ORDER_TYPE || "FAK").toUpperCase() === "FOK" ? "FOK" : "FAK",
    // Slippage for market orders: fraction (e.g. 0.03 = 3%) added to best ask for worst-price limit
    marketOrderSlippagePct: Math.max(0, Math.min(0.5, Number(process.env.MARKET_ORDER_SLIPPAGE_PCT ?? "0.03"))),
    // Default max price we're willing to pay for a share.
    maxBidPrice: Math.max(0.01, Math.min(0.99, Number(process.env.MAX_BID_PRICE ?? "0.95"))),
    // Confidence-to-max-price ladder.
    // Format example: "0:0.70,20:0.80,40:0.88,60:0.93,80:0.97"
    // Uses absolute confidence score (0..100), picks highest threshold <= current confidence.
    confidenceMaxBidLadder: (() => {
      const raw = String(process.env.CONFIDENCE_MAX_BID_LADDER ?? "");
      if (!raw.trim()) return [];
      const pairs = raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [thresholdRaw, priceRaw] = part.split(":").map((s) => s.trim());
          const threshold = Number(thresholdRaw);
          const price = Number(priceRaw);
          if (!Number.isFinite(threshold) || !Number.isFinite(price)) return null;
          return {
            threshold: Math.max(0, Math.min(100, Math.round(threshold))),
            maxPrice: Math.max(0.01, Math.min(0.99, price))
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.threshold - b.threshold);
      return pairs;
    })(),
    // Entry timing for live orders: place trade when remaining seconds is <= this value.
    tradeTimingSeconds: Math.max(0, Number(process.env.TRADE_TIMING_SECONDS ?? "60")),
    // Minimum model − market edge on the traded side (0–1). Stricter than display-only `decide()` in quiet regimes.
    liveMinModelEdge: Math.max(0, Math.min(0.5, Number(process.env.LIVE_MIN_MODEL_EDGE ?? "0.10"))),
    // Skip live bids when the ask is in this band (market is pricing ~50/50).
    coinFlipMinPrice: (() => {
      const a = Math.max(0.01, Math.min(0.99, Number(process.env.COIN_FLIP_MIN_PRICE ?? "0.42")));
      const b = Math.max(0.01, Math.min(0.99, Number(process.env.COIN_FLIP_MAX_PRICE ?? "0.58")));
      return Math.min(a, b);
    })(),
    coinFlipMaxPrice: (() => {
      const a = Math.max(0.01, Math.min(0.99, Number(process.env.COIN_FLIP_MIN_PRICE ?? "0.42")));
      const b = Math.max(0.01, Math.min(0.99, Number(process.env.COIN_FLIP_MAX_PRICE ?? "0.58")));
      return Math.max(a, b);
    })(),
    // Extra |confidence| required for DOWN live trades (logs showed weaker DOWN fills).
    downSideExtraThreshold: Math.max(0, Math.min(40, Number(process.env.DOWN_SIDE_EXTRA_THRESHOLD ?? "12"))),
    // Mean |Δconfidence| over chopWindowMs; above this → skip (whipsaw).
    maxConfidenceSwingMeanAbs: Math.max(0, Math.min(100, Number(process.env.MAX_CONFIDENCE_SWING_MEAN_ABS ?? "22"))),
    chopWindowMs: Math.max(5_000, Math.min(120_000, Number(process.env.CHOP_WINDOW_MS ?? "30000"))),
    // After this many live fills, if win rate < min, pause new bids for pauseMinutes.
    circuitBreakerWindow: Math.max(3, Math.min(30, Number(process.env.CIRCUIT_BREAKER_WINDOW ?? "8"))),
    circuitBreakerMinTrades: Math.max(2, Math.min(25, Number(process.env.CIRCUIT_BREAKER_MIN_TRADES ?? "6"))),
    circuitBreakerMinWinRate: Math.max(0, Math.min(1, Number(process.env.CIRCUIT_BREAKER_MIN_WIN_RATE ?? "0.45"))),
    circuitBreakerPauseMinutes: Math.max(1, Math.min(240, Number(process.env.CIRCUIT_BREAKER_PAUSE_MINUTES ?? "45"))),
    circuitBreakerEnabled: (process.env.CIRCUIT_BREAKER_ENABLED ?? "true").toLowerCase() !== "false",
    // Throttle high-volume CSV logs (signals + gpt_indicators).
    logSignalsThrottleMs: Math.max(0, Number(process.env.LOG_SIGNALS_THROTTLE_MS ?? "30000")),
    // Fewer terminal lines (keeps confidence, market, budget, key hints).
    quietConsole: (process.env.QUIET_CONSOLE ?? "false").toLowerCase() === "true",
    // Require `decide()` ENTER + same side as confidence (anti–coin-flip discipline).
    requireEdgeEngineEnter: (process.env.REQUIRE_EDGE_ENGINE_ENTER ?? "true").toLowerCase() !== "false",
    enforceCoinFlipGuard: (process.env.ENFORCE_COIN_FLIP_GUARD ?? "true").toLowerCase() !== "false",
    enforceChopGuard: (process.env.ENFORCE_CHOP_GUARD ?? "true").toLowerCase() !== "false",
    // Checkpoints (seconds remaining) for recording model prediction outcomes.
    predictionCheckpointsSeconds: (() => {
      const raw = String(process.env.PREDICTION_TIMINGS_SECONDS ?? "120,90,60");
      const parsed = raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.round(n));
      const unique = [...new Set(parsed)].sort((a, b) => b - a);
      return unique.length ? unique : [120, 90, 60];
    })()
  }
};
