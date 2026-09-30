import { CONFIG } from "../config.js";
import { getUsdcBalance as getRelayerUsdcBalance, placeMarketOrder } from "./polymarketRelayerClient.js";

/**
 * USDC balance in USD for the Polymarket smart wallet (when POLYMARKET_FUNDER_ADDRESS is set).
 * Returns null if funder is not set or balance cannot be read.
 */
export async function getUsdcBalanceUsd() {
  const funder = CONFIG.polymarket?.funderAddress?.trim();
  if (!funder) return null;
  return getRelayerUsdcBalance();
}

/**
 * Marketable BUY with a hard worst-price limit. `worstPrice` comes from the strategy: the highest
 * price at which the bet still clears its minimum edge after fees, so slippage can never turn a
 * +EV decision into a -EV fill.
 */
export async function executeLiveBuy({ tokenId, amountUsd, worstPrice, tickSize = 0.01, negRisk = false }) {
  if (!CONFIG.trading.enableLiveTrading) return { status: "disabled", reason: "ENABLE_LIVE_TRADING_false" };
  if (!CONFIG.trading.privateKey) return { status: "skipped", reason: "missing_private_key" };
  if (!CONFIG.polymarket?.funderAddress?.trim()) return { status: "skipped", reason: "missing_funder_address" };
  if (!tokenId) return { status: "skipped", reason: "missing_token_id" };
  if (!(amountUsd >= 1)) return { status: "skipped", reason: "amount_below_1usd" };
  if (!(worstPrice >= 0.01 && worstPrice <= 0.99)) return { status: "skipped", reason: "bad_worst_price" };

  const balance = await getRelayerUsdcBalance();
  if (balance === null || balance < amountUsd) return { status: "skipped", reason: "insufficient_usdc", balance };

  const res = await placeMarketOrder({
    tokenId,
    amountUsd: Math.floor(amountUsd * 100) / 100,
    worstPrice,
    tickSize: String(tickSize),
    negRisk
  });
  if (res.error) return { status: "error", reason: res.error };
  return {
    status: "ok",
    orderId: res.orderID ?? null,
    spentUsd: res.makingAmount,
    shares: res.takingAmount
  };
}
