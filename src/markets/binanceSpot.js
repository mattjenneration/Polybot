/** Minimal multi-symbol Binance spot helpers (the BTC bot's src/data/binance.js is pinned to CONFIG.symbol). */
const BINANCE_BASE = process.env.BINANCE_BASE_URL || "https://api.binance.com";

export async function fetchSpot(symbol) {
  const url = new URL("/api/v3/ticker/price", BINANCE_BASE);
  url.searchParams.set("symbol", symbol);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance price ${symbol} error: ${res.status}`);
  const n = Number((await res.json())?.price);
  return Number.isFinite(n) ? n : null;
}

/** Klines as [{ openTime, open, close }]. */
export async function fetchKlines(symbol, { interval = "1h", limit = 168, startTime = null } = {}) {
  const url = new URL("/api/v3/klines", BINANCE_BASE);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  if (startTime !== null) url.searchParams.set("startTime", String(startTime));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${symbol} error: ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), close: Number(k[4]) }));
}
