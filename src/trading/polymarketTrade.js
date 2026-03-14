import { ethers } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { CONFIG } from "../config.js";
import { appendCsvRow } from "../utils.js";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

let sharedClient = null;
let sharedWallet = null;
let sharedUsdc = null;

function getProvider() {
  return new ethers.JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl);
}

function getWallet() {
  if (sharedWallet) return sharedWallet;
  if (!CONFIG.trading.privateKey) return null;
  sharedWallet = new ethers.Wallet(CONFIG.trading.privateKey, getProvider());
  return sharedWallet;
}

function getUsdcContract() {
  if (sharedUsdc) return sharedUsdc;
  const wallet = getWallet();
  if (!wallet) return null;
  sharedUsdc = new ethers.Contract(CONFIG.trading.usdcAddress, ERC20_ABI, wallet);
  return sharedUsdc;
}

function getClobClient() {
  if (sharedClient) return sharedClient;
  const wallet = getWallet();
  if (!wallet) return null;
  sharedClient = new ClobClient(CONFIG.clobBaseUrl, CONFIG.trading.chainId, wallet, null);
  return sharedClient;
}

export async function getUsdcBalanceUsd() {
  const usdc = getUsdcContract();
  if (!usdc) return null;
  try {
    const [rawBal, decimals] = await Promise.all([usdc.balanceOf(await usdc.signer.getAddress()), usdc.decimals()]);
    const bal = Number(ethers.formatUnits(rawBal, decimals));
    return Number.isFinite(bal) ? bal : null;
  } catch {
    return null;
  }
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

  if (!marketSnapshot?.ok) {
    return { status: "skipped", reason: "bad_market_snapshot" };
  }

  const client = getClobClient();
  if (!client) {
    return { status: "skipped", reason: "no_clob_client" };
  }

  const upTokenId = marketSnapshot.tokens?.upTokenId ?? null;
  const downTokenId = marketSnapshot.tokens?.downTokenId ?? null;
  const tokenId = side === "UP" ? upTokenId : downTokenId;

  if (!tokenId) {
    return { status: "skipped", reason: "missing_token_id" };
  }

  const balanceUsd = await getUsdcBalanceUsd();
  if (balanceUsd === null || balanceUsd < amountUsd) {
    return { status: "skipped", reason: "insufficient_usdc", balanceUsd };
  }

  const prices = marketSnapshot.prices || {};
  const rawPriceCents = side === "UP" ? prices.up : prices.down;
  if (rawPriceCents === null || rawPriceCents === undefined || !Number.isFinite(Number(rawPriceCents))) {
    return { status: "skipped", reason: "missing_market_price" };
  }

  const price = Number(rawPriceCents) / 100;
  if (price <= 0 || !Number.isFinite(price)) {
    return { status: "skipped", reason: "bad_price" };
  }

  const size = amountUsd / price;
  if (!Number.isFinite(size) || size <= 0) {
    return { status: "skipped", reason: "bad_size" };
  }

  const sideEnum = Side.BUY;

  let orderResponse = null;
  let error = null;

  try {
    orderResponse = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: sideEnum
      },
      {
        tickSize: "0.01",
        negRisk: false
      },
      OrderType.GTC
    );
  } catch (err) {
    error = err;
  }

  const result = {
    status: orderResponse && !error ? "ok" : "error",
    orderId: orderResponse?.orderID ?? null,
    side,
    amountUsd,
    price,
    size,
    confidenceScore,
    errorMessage: error ? String(error?.message ?? error) : null
  };

  try {
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
  } catch {
  }

  return result;
}

