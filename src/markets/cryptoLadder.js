/**
 * Crypto price-ladder markets ("Bitcoin above $X on <date>", "between $X and $Y", "reach $X in October",
 * hourly/daily "Up or Down"), priced off the Deribit implied-vol surface (BTC/ETH) or Binance realized vol.
 *
 * Rationale: Polymarket "Yes" on BTC threshold contracts has traded 5–11pp above options-implied
 * probabilities, most on long shots / longer maturities, with a ~4h half-life (arXiv 2606.19517).
 */
import { probAbove, probTouch, realizedVol, MS_PER_YEAR, clampProb } from "./math.js";
import { getSurface, surfaceIv } from "./deribit.js";
import { fetchSpot, fetchKlines } from "./binanceSpot.js";

export const ASSETS = {
  BTC: { pattern: /\b(bitcoin|btc)\b/i, binance: "BTCUSDT", deribit: "BTC" },
  ETH: { pattern: /\b(ethereum|ether|eth)\b/i, binance: "ETHUSDT", deribit: "ETH" },
  SOL: { pattern: /\b(solana|sol)\b/i, binance: "SOLUSDT", deribit: null },
  XRP: { pattern: /\b(xrp|ripple)\b/i, binance: "XRPUSDT", deribit: null }
};

function parseMoney(raw) {
  const m = /^\$?\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?$/.exec(String(raw).trim());
  if (!m) return null;
  let n = Number(m[1].replaceAll(",", ""));
  if (!Number.isFinite(n)) return null;
  if (m[2] && m[2].toLowerCase() === "k") n *= 1_000;
  if (m[2] && m[2].toLowerCase() === "m") n *= 1_000_000;
  return n;
}

const MONEY = String.raw`\$?\s*[\d,]+(?:\.\d+)?\s*[kKmM]?`;

/**
 * Parse a market into a contract spec, or null if it's not a supported crypto price market.
 * kinds: above | below | between | touch_up | touch_down | updown
 */
export function parseCryptoMarket(market, { enabledAssets = Object.keys(ASSETS), minUpDownMinutes = 60 } = {}) {
  const q = `${market.question}`;
  if (/market cap|dominance|ratio|\betf\b|flows?\b|treasury|reserve|flip/i.test(q)) return null;
  const matched = Object.keys(ASSETS).filter((a) => ASSETS[a].pattern.test(q));
  if (matched.length !== 1 || !enabledAssets.includes(matched[0]) || !market.endMs) return null;
  const asset = matched[0];
  const base = { asset, expiryMs: market.endMs };

  if (/up or down/i.test(q)) {
    const startMs = market.eventStartMs;
    if (!startMs || (market.endMs - startMs) / 60_000 < minUpDownMinutes) return null; // 5m/15m belong to the BTC bot
    return { ...base, kind: "updown", startMs };
  }

  let m = new RegExp(String.raw`between\s+(${MONEY})\s+(?:and|-|to)\s+(${MONEY})`, "i").exec(q);
  if (m) {
    const lo = parseMoney(m[1]);
    const hi = parseMoney(m[2]);
    if (lo && hi && hi > lo) return { ...base, kind: "between", lo, hi };
  }
  m = new RegExp(String.raw`\b(reach|hit|rise to|surpass)\s+(${MONEY})`, "i").exec(q);
  if (m) {
    const k = parseMoney(m[2]);
    if (k) return { ...base, kind: "touch_up", lo: k };
  }
  m = new RegExp(String.raw`\b(dip to|drop to|fall to|dip below)\s+(${MONEY})`, "i").exec(q);
  if (m) {
    const k = parseMoney(m[2]);
    if (k) return { ...base, kind: "touch_down", lo: k };
  }
  m = new RegExp(String.raw`\b(above|greater than|higher than|over|at least)\s+(${MONEY})`, "i").exec(q);
  if (m) {
    const k = parseMoney(m[2]);
    if (k) return { ...base, kind: "above", lo: k };
  }
  m = new RegExp(String.raw`\b(below|less than|lower than|under)\s+(${MONEY})`, "i").exec(q);
  if (m) {
    const k = parseMoney(m[2]);
    if (k) return { ...base, kind: "below", lo: k };
  }
  return null;
}

/** Pure pricer: probability the market's YES outcome wins. `ivAt(strike)` gives annualized vol. */
export function priceContract(spec, { spot, ivAt, nowMs = Date.now(), strikeForUpDown = null }) {
  const tYears = Math.max(0, (spec.expiryMs - nowMs) / MS_PER_YEAR);
  switch (spec.kind) {
    case "above":
      return probAbove({ spot, strike: spec.lo, sigma: ivAt(spec.lo), tYears });
    case "below": {
      const p = probAbove({ spot, strike: spec.lo, sigma: ivAt(spec.lo), tYears });
      return p === null ? null : 1 - p;
    }
    case "between": {
      const a = probAbove({ spot, strike: spec.lo, sigma: ivAt(spec.lo), tYears });
      const b = probAbove({ spot, strike: spec.hi, sigma: ivAt(spec.hi), tYears });
      return a === null || b === null ? null : clampProb(a - b);
    }
    case "touch_up":
      return spot >= spec.lo ? 1 : probTouch({ spot, barrier: spec.lo, sigma: ivAt(spec.lo), tYears });
    case "touch_down":
      return spot <= spec.lo ? 1 : probTouch({ spot, barrier: spec.lo, sigma: ivAt(spec.lo), tYears });
    case "updown": {
      if (!(strikeForUpDown > 0)) return null;
      // Up wins on close >= open
      const p = probAbove({ spot, strike: strikeForUpDown, sigma: ivAt(strikeForUpDown), tYears });
      return p;
    }
    default:
      return null;
  }
}

/** Creates the module used by the runner. */
export function createCryptoLadderModule(opts = {}) {
  const enabledAssets = (opts.assets ?? ["BTC", "ETH", "SOL", "XRP"]).filter((a) => ASSETS[a]);
  const realizedCache = new Map();
  const openCache = new Map();

  async function realizedFor(asset) {
    const hit = realizedCache.get(asset);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.vol;
    const kl = await fetchKlines(ASSETS[asset].binance, { interval: "1h", limit: 24 * 14 });
    const vol = realizedVol(kl.map((k) => k.close), 3_600_000);
    realizedCache.set(asset, { vol, at: Date.now() });
    return vol;
  }

  /** Binance 1m candle open at the window start (Up/Down "price to beat"). */
  async function openAt(asset, startMs) {
    const key = `${asset}:${startMs}`;
    if (openCache.has(key)) return openCache.get(key);
    const kl = await fetchKlines(ASSETS[asset].binance, { interval: "1m", limit: 1, startTime: startMs });
    const open = kl[0] && kl[0].openTime === startMs ? kl[0].open : null;
    if (open) openCache.set(key, open);
    return open;
  }

  return {
    name: "crypto_ladder",
    feeCategory: "crypto",
    tags: opts.tags ?? ["crypto"],
    endWithinMs: (opts.maxDays ?? 35) * 24 * 3_600_000,

    parse(market) {
      return parseCryptoMarket(market, { enabledAssets, minUpDownMinutes: opts.minUpDownMinutes ?? 60 });
    },

    /** Price parsed markets. Returns Map(marketId → { p, meta }). */
    async priceAll(items, nowMs = Date.now()) {
      const out = new Map();
      const byAsset = new Map();
      for (const it of items) {
        const list = byAsset.get(it.spec.asset) ?? [];
        list.push(it);
        byAsset.set(it.spec.asset, list);
      }
      for (const [asset, list] of byAsset) {
        let spot;
        try {
          spot = await fetchSpot(ASSETS[asset].binance);
        } catch {
          continue;
        }
        if (!(spot > 0)) continue;
        let surface = null;
        if (ASSETS[asset].deribit) {
          try {
            surface = await getSurface(ASSETS[asset].deribit);
          } catch {
            surface = null;
          }
        }
        let rv = null;
        if (!surface) {
          try {
            rv = await realizedFor(asset);
          } catch {
            rv = null;
          }
        }
        for (const it of list) {
          const ivAt = (strike) => (surface ? surfaceIv(surface, strike, it.spec.expiryMs, nowMs) : rv);
          let strikeForUpDown = null;
          if (it.spec.kind === "updown") {
            if (it.spec.startMs > nowMs) continue; // window not started, strike unknown
            try {
              strikeForUpDown = await openAt(asset, it.spec.startMs);
            } catch {
              continue;
            }
          }
          const p = priceContract(it.spec, { spot, ivAt, nowMs, strikeForUpDown });
          if (p === null || !Number.isFinite(p)) continue;
          const refStrike = it.spec.lo ?? strikeForUpDown;
          out.set(it.market.id, {
            p,
            meta: {
              asset,
              kind: it.spec.kind,
              spot,
              strike: refStrike,
              strikeHi: it.spec.hi ?? "",
              iv: refStrike ? ivAt(refStrike) : null,
              volSource: surface ? "deribit" : "realized"
            }
          });
        }
      }
      return out;
    }
  };
}
