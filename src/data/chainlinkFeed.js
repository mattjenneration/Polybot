import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

function toNum(x) {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Source timestamps arrive in seconds or milliseconds depending on the message; normalize to ms. */
export function normalizeTimestampMs(x) {
  const n = toNum(x);
  if (n === null) return null;
  return n > 1e12 ? Math.floor(n) : Math.floor(n * 1000);
}

/**
 * Parse one Polymarket real-time-data message into BTC/USD Chainlink ticks.
 * Handles single updates and batched `payload.data` arrays.
 */
export function parseChainlinkMessage(data, rx, symbolIncludes = "btc") {
  if (!data || data.topic !== "crypto_prices_chainlink") return [];
  const payload = typeof data.payload === "string" ? JSON.parse(data.payload) : data.payload ?? {};
  const symbol = String(payload.symbol ?? payload.pair ?? "").toLowerCase();
  if (symbolIncludes && !symbol.includes(symbolIncludes)) return [];

  const rows = Array.isArray(payload.data) ? payload.data : [payload];
  const out = [];
  for (const row of rows) {
    const price = toNum(row.value ?? row.price);
    const ts = normalizeTimestampMs(row.timestamp ?? payload.timestamp ?? data.timestamp);
    if (price === null || ts === null) continue;
    out.push({ ts, rx, price });
  }
  return out;
}

/**
 * Chainlink BTC/USD stream from Polymarket's real-time data socket — the same feed markets settle on.
 * Every tick carries its source timestamp (`ts`) and local receive time (`rx`); consumers decide freshness.
 */
export function startChainlinkFeed({ wsUrl = CONFIG.polymarket.liveDataWsUrl, onTick } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let pingTimer = null;
  let last = null;
  let lastMessageRx = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000, agent: wsAgentForUrl(wsUrl) });

    const scheduleReconnect = () => {
      if (closed) return;
      clearInterval(pingTimer);
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      ws = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(connect, wait);
    };

    ws.on("open", () => {
      reconnectMs = 500;
      ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: "" }]
      }));
      pingTimer = setInterval(() => {
        try {
          ws?.ping();
        } catch {
          // ignore
        }
        // Silent socket: force a reconnect rather than serving an ever-older price.
        if (lastMessageRx && Date.now() - lastMessageRx > 30_000) scheduleReconnect();
      }, 5000);
    });

    ws.on("message", (buf) => {
      const rx = Date.now();
      lastMessageRx = rx;
      let data;
      try {
        data = JSON.parse(buf.toString());
      } catch {
        return;
      }
      let ticks;
      try {
        ticks = parseChainlinkMessage(data, rx);
      } catch {
        return;
      }
      for (const t of ticks) {
        if (last && t.ts <= last.ts) continue;
        last = t;
        onTick?.(t);
      }
    });

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();

  return {
    getLast: () => last,
    close() {
      closed = true;
      clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    }
  };
}
