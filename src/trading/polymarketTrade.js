import { CONFIG } from "../config.js";
import { appendCsvRow } from "../utils.js";
import {
  getUsdcBalance as getRelayerUsdcBalance,
  getAccountInfo,
  placeMarketOrder as relayerPlaceMarketOrder
} from "./polymarketRelayerClient.js";

/**
 * USDC balance in USD for the Polymarket smart wallet (when POLYMARKET_FUNDER_ADDRESS is set).
 * Returns null if funder is not set or balance cannot be read.
 */
export async function getUsdcBalanceUsd() {
  const funder = CONFIG.polymarket?.funderAddress?.trim();
  if (!funder) return null;
  return getRelayerUsdcBalance();
}

export async function executeTradeIfEnabled({
  side,
  amountUsd,
  marketSnapshot,
  confidenceScore,
  now = new Date()
}) {
  if (!CONFIG.trading.enableLiveTrading) {
    return { status: "disabled", reason: "ENABLE_LIVE_TRADING_false" };
  }

  if (!CONFIG.trading.privateKey) {
    return { status: "skipped", reason: "missing_private_key" };
  }

  const funder = CONFIG.polymarket?.funderAddress?.trim();
  if (!funder) {
    const accountInfo = await getAccountInfo();
    return {
      status: "skipped",
      reason: "missing_funder_address",
      walletAddress: accountInfo.walletAddress ?? null
    };
  }

  if (!marketSnapshot?.ok) {
    return { status: "skipped", reason: "bad_market_snapshot" };
  }

  const upTokenId = marketSnapshot.tokens?.upTokenId ?? null;
  const downTokenId = marketSnapshot.tokens?.downTokenId ?? null;
  const tokenId = side === "UP" ? upTokenId : downTokenId;

  if (!tokenId) {
    return { status: "skipped", reason: "missing_token_id" };
  }

  const balanceUsd = await getRelayerUsdcBalance();
  if (balanceUsd === null || balanceUsd < amountUsd) {
    const accountInfo = await getAccountInfo();
    return {
      status: "skipped",
      reason: "insufficient_usdc",
      balanceUsd,
      walletAddress: accountInfo.walletAddress ?? null
    };
  }

  const prices = marketSnapshot.prices || {};
  const orderbook = marketSnapshot.orderbook || {};
  const book = side === "UP" ? orderbook.up : orderbook.down;
  const bestAsk = book?.bestAsk != null && Number.isFinite(Number(book.bestAsk)) ? Number(book.bestAsk) : null;
  const rawPrice = side === "UP" ? prices.up : prices.down;
  const fallbackPrice = rawPrice != null && Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null;

  if (bestAsk === null && fallbackPrice === null) {
    return { status: "skipped", reason: "missing_market_price" };
  }

  // For market BUY, use best ask (price to take liquidity) + slippage as worst-price limit.
  const minPrice = 0.01;
  const maxPrice = 0.99;
  const tick = 0.01;
  const slippagePct = CONFIG.trading.marketOrderSlippagePct ?? 0.03;
  const basePrice = bestAsk ?? fallbackPrice;
  if (basePrice <= 0 || !Number.isFinite(basePrice)) {
    return { status: "skipped", reason: "bad_price" };
  }

  // Risk control: never bid if the outcome probability is already very high.
  // This avoids buying at/near 1.00 where a correct pick only pays back a tiny amount.
  const neverBidAbove = 0.95;
  if (basePrice > neverBidAbove) {
    return { status: "skipped", reason: "market_price_above_95c" };
  }

  let worstPrice = basePrice * (1 + slippagePct);
  if (worstPrice < minPrice) worstPrice = minPrice;
  if (worstPrice > maxPrice) worstPrice = maxPrice;
  worstPrice = Math.round(worstPrice / tick) * tick;
  if (worstPrice >= 1) worstPrice = maxPrice;

  const price = basePrice;
  const size = amountUsd / price;
  if (!Number.isFinite(size) || size <= 0) {
    return { status: "skipped", reason: "bad_size" };
  }

  const placeResult = await relayerPlaceMarketOrder({
    tokenId,
    side,
    amountUsd,
    worstPrice,
    tickSize: "0.01",
    negRisk: false
  });

  const orderId = placeResult.orderID ?? placeResult.orderId ?? null;
  let error = placeResult.error ?? null;
  const rawStatus = placeResult.status;
  if (!error && typeof rawStatus === "number" && Number.isFinite(rawStatus) && rawStatus >= 400) {
    error = `http_${rawStatus}`;
  }
  const status = error ? "error" : "ok";

  const result = {
    status,
    orderId,
    side,
    amountUsd,
    price,
    size,
    confidenceScore,
    errorMessage: error ?? null
  };

  try {
    // Core trade history (high level).
    appendCsvRow("./logs/trade_history.csv", [
      "timestamp",
      "status",
      "side",
      "amount_usd",
      "price",
      "size",
      "confidence_score",
      "order_id",
      "error"
    ], [
      now.toISOString(),
      result.status,
      side,
      amountUsd.toFixed(2),
      price.toFixed(4),
      size.toFixed(6),
      confidenceScore,
      result.orderId ?? "",
      result.errorMessage ?? ""
    ]);

    // Extended live-trade debug log with more context.
    const market = marketSnapshot.market || {};
    const marketSlug = market.slug ?? "";
    const debugOrderbookUp = marketSnapshot.orderbook?.up ?? {};
    const debugOrderbookDown = marketSnapshot.orderbook?.down ?? {};

    appendCsvRow("./logs/live_trades_debug.csv", [
      "timestamp",
      "status",
      "side",
      "amount_usd",
      "price",
      "size",
      "confidence_score",
      "order_id",
      "error",
      "market_slug",
      "token_id",
      "balance_usd_before",
      "market_price_up",
      "market_price_down",
      "up_best_bid",
      "up_best_ask",
      "down_best_bid",
      "down_best_ask",
      "clob_status_raw",
      "clob_response_raw"
    ], [
      now.toISOString(),
      result.status,
      side,
      amountUsd.toFixed(2),
      price.toFixed(4),
      size.toFixed(6),
      confidenceScore,
      result.orderId ?? "",
      result.errorMessage ?? "",
      marketSlug,
      tokenId,
      balanceUsd !== null && Number.isFinite(balanceUsd) ? balanceUsd.toFixed(6) : "",
      prices.up ?? "",
      prices.down ?? "",
      debugOrderbookUp.bestBid ?? "",
      debugOrderbookUp.bestAsk ?? "",
      debugOrderbookDown.bestBid ?? "",
      debugOrderbookDown.bestAsk ?? "",
      placeResult.status ?? "",
      JSON.stringify(placeResult)
    ]);
  } catch {
  }

  return result;
}
