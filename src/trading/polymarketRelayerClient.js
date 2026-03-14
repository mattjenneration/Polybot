/**
 * Polymarket smart-wallet / CLOB client wrapper.
 * Uses the proxy (funder) address for balance and orders; PRIVATE_KEY signs as the EOA that controls the proxy.
 * Balance: when funder is set we read USDC on-chain from the proxy so Budget and "insufficient funds" use the real balance.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { ethers } from "ethers";
import { ClobClient, Side, OrderType, SignatureType, AssetType } from "@polymarket/clob-client";
import { CONFIG } from "../config.js";

const USDC_DECIMALS = 6;
const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
];
const GET_BALANCE_ALLOWANCE = "/balance-allowance";
const TIME_PATH = "/time";
const GET = "GET";

/** Fetch CLOB server time (unix seconds) for L2 auth; fallback to local time. */
async function getClobServerTime() {
  const host = CONFIG.clobBaseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${host}${TIME_PATH}`);
    if (!res.ok) return Math.floor(Date.now() / 1000);
    const data = await res.json();
    const t = typeof data === "number" ? data : data?.timestamp ?? data?.time ?? data?.epoch;
    return Number.isFinite(t) ? Math.floor(Number(t)) : Math.floor(Date.now() / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

let sharedClient = null;
let apiCredsResolved = null;

function appendApiLog(entry) {
  try {
    fs.mkdirSync("./logs", { recursive: true });
    const line = JSON.stringify(entry);
    fs.appendFileSync("./logs/api.log", `${line}\n`, "utf8");
  } catch {
    // ignore logging errors
  }
}

/**
 * Adapter so ethers v6 Wallet works with @polymarket/clob-client (which expects _signTypedData).
 * @param {ethers.Wallet} wallet
 * @returns {import("@polymarket/clob-client").ClobSigner}
 */
function ethersV6SignerAdapter(wallet) {
  if (!wallet || typeof wallet.signTypedData !== "function") return wallet;
  return {
    getAddress: () => wallet.getAddress(),
    _signTypedData(domain, types, value) {
      return wallet.signTypedData(domain, types, value);
    }
  };
}

function getSigner() {
  if (!CONFIG.trading.privateKey) return null;
  const provider = new ethers.JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl, CONFIG.trading.chainId);
  const wallet = new ethers.Wallet(CONFIG.trading.privateKey, provider);
  return ethersV6SignerAdapter(wallet);
}

/**
 * Resolve API credentials (create or derive) for L2 auth. Uses a temporary client with EOA only.
 * @returns {Promise<{ apiKey: string, secret: string, passphrase: string } | null>}
 */
async function resolveApiCreds() {
  if (apiCredsResolved) return apiCredsResolved;
  const signer = getSigner();
  if (!signer) return null;
  const tempClient = new ClobClient(
    CONFIG.clobBaseUrl,
    CONFIG.trading.chainId,
    signer,
    undefined,
    undefined,
    undefined
  );
  try {
    const creds = await tempClient.createOrDeriveApiKey();
    apiCredsResolved = creds;
    return creds;
  } catch (err) {
    console.error("[Polymarket] Failed to create/derive API key:", err?.message ?? String(err));
    return null;
  }
}

/**
 * Get the shared CLOB client configured for the Polymarket smart wallet (signature type 2, funder).
 * @returns {Promise<import("@polymarket/clob-client").ClobClient | null>}
 */
async function getClobClient() {
  if (sharedClient) return sharedClient;
  const signer = getSigner();
  const funderAddress = CONFIG.polymarket?.funderAddress?.trim();
  if (!signer || !funderAddress) return null;

  const creds = await resolveApiCreds();
  if (!creds) return null;

  sharedClient = new ClobClient(
    CONFIG.clobBaseUrl,
    CONFIG.trading.chainId,
    signer,
    creds,
    SignatureType.POLY_GNOSIS_SAFE,
    funderAddress
  );
  return sharedClient;
}

/**
 * Account info for the Polymarket proxy (funder) used for trading.
 * @returns {Promise<{ walletAddress: string | null }>}
 */
export async function getAccountInfo() {
  const funder = CONFIG.polymarket?.funderAddress?.trim();
  return { walletAddress: funder || null };
}

/**
 * Build Polymarket CLOB L2 HMAC signature (same as clob-client signing/hmac.js).
 * @param {string} secret - base64 API secret
 * @param {number} timestamp - unix seconds
 * @param {string} method - e.g. "GET"
 * @param {string} requestPath - e.g. "/balance-allowance"
 * @param {string} [body] - optional body for POST
 * @returns {string} url-safe base64 signature
 */
function buildPolyHmacSignature(secret, timestamp, method, requestPath, body) {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined && body !== "") {
    message += body;
  }
  const key = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  const sig = crypto.createHmac("sha256", key).update(message).digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Fetch balance-allowance from CLOB. API key is bound to the signer, so POLY_ADDRESS must be the signer.
 * With signature_type=2 the server returns the proxy (funder) balance for that signer.
 * @returns {Promise<{ balance: string, allowance: string } | null>}
 */
async function getBalanceAllowanceWithFunderAddress() {
  if (!CONFIG.polymarket?.funderAddress?.trim()) return null;
  const signer = getSigner();
  if (!signer) return null;
  let signerAddress;
  try {
    signerAddress = await signer.getAddress();
  } catch {
    return null;
  }
  if (!signerAddress) return null;
  const creds = await resolveApiCreds();
  if (!creds) {
    console.error("[Polymarket balance] No API credentials (createOrDeriveApiKey failed or missing PRIVATE_KEY)");
    return null;
  }

  const host = CONFIG.clobBaseUrl.replace(/\/$/, "");
  const requestPath = GET_BALANCE_ALLOWANCE;
  const ts = await getClobServerTime();
  const sig = buildPolyHmacSignature(creds.secret, ts, GET, requestPath);

  const headers = {
    POLY_ADDRESS: signerAddress,
    POLY_SIGNATURE: sig,
    POLY_TIMESTAMP: `${ts}`,
    POLY_API_KEY: creds.key,
    POLY_PASSPHRASE: creds.passphrase,
    "Content-Type": "application/json",
    Accept: "*/*"
  };

  const url = `${host}${requestPath}?asset_type=COLLATERAL&signature_type=${SignatureType.POLY_GNOSIS_SAFE}`;
  try {
    const res = await fetch(url, { method: GET, headers });
    if (!res.ok) {
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      console.error(
        `[Polymarket balance] API error: ${res.status} ${res.statusText} | body:`,
        typeof body === "object" ? JSON.stringify(body) : body
      );
      return null;
    }
    const data = await res.json();
    const balance = data?.balance ?? data?.data?.balance;
    if (balance === undefined || balance === null) return null;
    return { balance: String(balance), allowance: data?.allowance ?? data?.data?.allowance ?? "0" };
  } catch (err) {
    console.error("[Polymarket balance] Request failed:", err?.message ?? String(err));
    return null;
  }
}

/**
 * Read USDC balance of an address on-chain (Polygon). Used for the proxy so we show real balance.
 * @param {string} address - Wallet or contract address
 * @returns {Promise<number | null>} Balance in USD, or null on error
 */
async function getUsdcBalanceOnChain(address) {
  if (!address || !CONFIG.trading.usdcAddress) return null;
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl, CONFIG.trading.chainId);
    const usdc = new ethers.Contract(CONFIG.trading.usdcAddress, ERC20_ABI, provider);
    const [rawBal, decimals] = await Promise.all([usdc.balanceOf(address), usdc.decimals()]);
    const dec = Number(decimals ?? USDC_DECIMALS);
    const bal = Number(ethers.formatUnits(rawBal, dec));
    return Number.isFinite(bal) ? bal : null;
  } catch {
    return null;
  }
}

/**
 * USDC balance of the Polymarket smart wallet (funder), in USD.
 * When funder is set we read on-chain USDC from the proxy so Budget and trading use the real balance.
 * Falls back to CLOB balance-allowance only if on-chain read fails.
 * @returns {Promise<number | null>}
 */
export async function getUsdcBalance() {
  const funderAddress = CONFIG.polymarket?.funderAddress?.trim();
  if (funderAddress) {
    const onChain = await getUsdcBalanceOnChain(funderAddress);
    if (onChain !== null) return onChain;
  }
  try {
    let res = await getBalanceAllowanceWithFunderAddress();
    if (!res) {
      const client = await getClobClient();
      if (client) {
        try {
          const sdkRes = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          if (sdkRes && (sdkRes.balance !== undefined || sdkRes.allowance !== undefined)) {
            res = { balance: sdkRes.balance ?? "0", allowance: sdkRes.allowance ?? "0" };
          }
        } catch {
          // ignore
        }
      }
    }
    if (!res) return null;
    const raw = res.balance;
    if (raw === undefined || raw === null) return null;
    const bal = Number(raw) / 10 ** USDC_DECIMALS;
    return Number.isFinite(bal) ? bal : null;
  } catch {
    return null;
  }
}

/**
 * Place a limit order via the CLOB (smart wallet is the funder).
 * @param {{
 *   tokenId: string;
 *   side: "UP" | "DOWN";
 *   size: number;
 *   price: number;
 *   tickSize?: string;
 *   negRisk?: boolean;
 * }} params
 * @returns {Promise<{ orderID?: string; status?: string; error?: string }>}
 */
export async function placeOrder({ tokenId, side, size, price, tickSize = "0.01", negRisk = false }) {
  const client = await getClobClient();
  if (!client) {
    appendApiLog({
      ts: new Date().toISOString(),
      type: "clob_order",
      level: "error",
      ctx: "no_clob_client",
      request: { tokenId, side, size, price, tickSize, negRisk }
    });
    return { error: "no_clob_client" };
  }
  try {
    const orderSide = Side.BUY;
    const orderReq = {
      tokenID: tokenId,
      price,
      size,
      side: orderSide
    };
    const orderOpts = { tickSize, negRisk };

    if (CONFIG.trading.debugLiveTrading) {
      console.log("[LiveTrade] Posting order to CLOB", {
        tokenId,
        side,
        size,
        price,
        tickSize,
        negRisk
      });
    }

    const response = await client.createAndPostOrder(orderReq, orderOpts, OrderType.GTC);

    const summary = {
      orderID: response?.orderID ?? response?.orderId ?? null,
      status: response?.status ?? null
    };

    if (CONFIG.trading.debugLiveTrading) {
      console.log("[LiveTrade] CLOB response", {
        ...summary,
        raw: response
      });
    }

    appendApiLog({
      ts: new Date().toISOString(),
      type: "clob_order",
      level: "info",
      request: { tokenId, side, size, price, tickSize, negRisk },
      response: summary,
      rawResponse: response
    });

    return {
      orderID: summary.orderID,
      status: summary.status ?? "ok"
    };
  } catch (err) {
    if (CONFIG.trading.debugLiveTrading) {
      console.error("[LiveTrade] CLOB order error", err);
    }
    appendApiLog({
      ts: new Date().toISOString(),
      type: "clob_order",
      level: "error",
      request: { tokenId, side, size, price, tickSize, negRisk },
      error: {
        message: err?.message ?? String(err),
        name: err?.name ?? undefined,
        code: err?.code ?? undefined,
        status: err?.status ?? err?.statusCode ?? undefined,
        responseStatus: err?.response?.status ?? undefined,
        responseData: err?.response?.data ?? undefined
      }
    });
    return {
      error: err?.message ?? String(err)
    };
  }
}
