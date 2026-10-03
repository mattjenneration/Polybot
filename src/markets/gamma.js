/** Polymarket Gamma (discovery / resolution) and CLOB (order book) access for the multi-market simulator. */
import { CONFIG } from "../config.js";

function parseJsonArray(x) {
  if (Array.isArray(x)) return x;
  if (typeof x !== "string") return [];
  try {
    const v = JSON.parse(x);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Normalize a Gamma market into the fields the simulator needs. Returns null for non-binary / non-orderbook markets. */
export function normalizeGammaMarket(m, event = null) {
  if (!m) return null;
  const outcomes = parseJsonArray(m.outcomes).map(String);
  const tokenIds = parseJsonArray(m.clobTokenIds).map(String);
  if (outcomes.length !== 2 || tokenIds.length !== 2) return null;
  let yesIdx = outcomes.findIndex((o) => /^(yes|up)$/i.test(o));
  if (yesIdx < 0) yesIdx = 0;
  const noIdx = 1 - yesIdx;
  const endMs = m.endDate ? new Date(m.endDate).getTime() : null;
  const startRaw = m.eventStartTime ?? event?.startTime ?? m.startTime ?? null;
  return {
    id: String(m.id),
    slug: String(m.slug ?? ""),
    question: String(m.question ?? ""),
    description: String(m.description ?? event?.description ?? ""),
    groupItemTitle: String(m.groupItemTitle ?? ""),
    eventTitle: String(event?.title ?? ""),
    eventSlug: String(event?.slug ?? ""),
    outcomes,
    yesLabel: outcomes[yesIdx],
    noLabel: outcomes[noIdx],
    yesTokenId: tokenIds[yesIdx],
    noTokenId: tokenIds[noIdx],
    yesIdx,
    endMs: Number.isFinite(endMs) ? endMs : null,
    eventStartMs: startRaw ? new Date(startRaw).getTime() || null : null,
    bestBid: Number.isFinite(Number(m.bestBid)) ? Number(m.bestBid) : null,
    bestAsk: Number.isFinite(Number(m.bestAsk)) ? Number(m.bestAsk) : null,
    liquidity: Number(m.liquidityNum ?? m.liquidity) || 0,
    volume24hr: Number(m.volume24hr) || 0,
    active: m.active !== false,
    closed: Boolean(m.closed),
    acceptingOrders: m.acceptingOrders !== false,
    enableOrderBook: m.enableOrderBook !== false,
    raw: m
  };
}

/**
 * Active events for a Gamma tag slug, flattened to normalized markets.
 * `endWithinMs` limits to events ending soon (keeps the crypto tag from returning thousands of far-dated markets).
 */
export async function fetchMarketsByTag(tagSlug, { endWithinMs = null, maxPages = 10, pageSize = 100 } = {}) {
  const out = [];
  const now = Date.now();
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL("/events", CONFIG.gammaBaseUrl);
    url.searchParams.set("tag_slug", tagSlug);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(page * pageSize));
    url.searchParams.set("end_date_min", new Date(now).toISOString());
    if (endWithinMs) url.searchParams.set("end_date_max", new Date(now + endWithinMs).toISOString());
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma events(tag=${tagSlug}) error: ${res.status}`);
    const events = await res.json();
    if (!Array.isArray(events) || !events.length) break;
    for (const e of events) {
      for (const m of Array.isArray(e.markets) ? e.markets : []) {
        const nm = normalizeGammaMarket(m, e);
        if (nm && nm.active && !nm.closed && nm.enableOrderBook) out.push(nm);
      }
    }
    if (events.length < pageSize) break;
  }
  return out;
}

/** Resolution: { resolved: true, yesWon } once Gamma shows the market closed with a 0/1 outcome price. */
export async function fetchResolution(marketId) {
  const url = new URL(`/markets/${encodeURIComponent(marketId)}`, CONFIG.gammaBaseUrl);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma market ${marketId} error: ${res.status}`);
  return parseResolution(await res.json());
}

export function parseResolution(m) {
  const nm = normalizeGammaMarket(m);
  if (!nm || !m.closed) return { resolved: false };
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  const yesPrice = prices[nm.yesIdx];
  if (!Number.isFinite(yesPrice)) return { resolved: false };
  if (yesPrice >= 0.99) return { resolved: true, yesWon: true };
  if (yesPrice <= 0.01) return { resolved: true, yesWon: false };
  return { resolved: false };
}

/** Order books for many tokens: POST /books (batched), falling back to GET /book per token. Map tokenId → { asks, bids }. */
export async function fetchBooks(tokenIds, { batchSize = 50 } = {}) {
  const books = new Map();
  const ids = [...new Set(tokenIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    try {
      const res = await fetch(new URL("/books", CONFIG.clobBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk.map((token_id) => ({ token_id })))
      });
      if (!res.ok) throw new Error(`CLOB books error: ${res.status}`);
      const data = await res.json();
      for (const b of Array.isArray(data) ? data : []) {
        if (b?.asset_id) books.set(String(b.asset_id), { asks: b.asks ?? [], bids: b.bids ?? [] });
      }
    } catch {
      for (const id of chunk) {
        try {
          const url = new URL("/book", CONFIG.clobBaseUrl);
          url.searchParams.set("token_id", id);
          const res = await fetch(url);
          if (!res.ok) continue;
          const b = await res.json();
          books.set(id, { asks: b.asks ?? [], bids: b.bids ?? [] });
        } catch {
          // skip token
        }
      }
    }
  }
  return books;
}

export function bestPrice(levels, side) {
  let best = null;
  for (const l of Array.isArray(levels) ? levels : []) {
    const p = Number(l?.price);
    if (!Number.isFinite(p) || !(Number(l?.size) > 0)) continue;
    if (best === null || (side === "ask" ? p < best : p > best)) best = p;
  }
  return best;
}
