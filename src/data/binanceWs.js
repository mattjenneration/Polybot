import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

/**
 * Binance spot trade stream. Used as a fast-moving reference: Binance usually moves a beat
 * before the aggregated Chainlink price that markets settle on.
 * `ts` is the local receive time so freshness checks share one clock with the rest of the bot.
 */
export function startBinanceTradeStream({ symbol = CONFIG.binanceSymbol } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let last = null;

  const connect = () => {
    if (closed) return;
    const url = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    ws.on("open", () => {
      reconnectMs = 500;
    });

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const price = Number(msg.p);
        if (!Number.isFinite(price) || price <= 0) return;
        last = { ts: Date.now(), price };
      } catch {
        // ignore malformed frames
      }
    });

    const scheduleReconnect = () => {
      if (closed) return;
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

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();

  return {
    getLast: () => last,
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
    }
  };
}
