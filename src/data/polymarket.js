import { CONFIG } from "../config.js";
import { normalizeFeeSchedule } from "../core/fees.js";
import { normalizeBook } from "../core/orderbook.js";

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url.pathname ?? url} → HTTP ${res.status}`);
  return res.json();
}

function parseMaybeJsonArray(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    try {
      const v = JSON.parse(x);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

function timeMs(x) {
  const t = x ? new Date(x).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

export const ROUND_SECONDS = 300;
export const SLUG_PREFIX = "btc-updown-5m";

/** Slug of the 5m round containing `nowMs` (slugs are keyed by the round's start in unix seconds). */
export function slugForTime(nowMs, prefix = SLUG_PREFIX, roundSeconds = ROUND_SECONDS) {
  const start = Math.floor(nowMs / 1000 / roundSeconds) * roundSeconds;
  return `${prefix}-${start}`;
}

export async function fetchEventBySlug(slug) {
  const url = new URL("/events", CONFIG.gammaBaseUrl);
  url.searchParams.set("slug", slug);
  const data = await getJson(url);
  const ev = Array.isArray(data) ? data[0] : data;
  return ev ?? null;
}

export async function fetchLiveEventsBySeriesId({ seriesId, limit = 50, nowMs = Date.now() }) {
  const url = new URL("/events", CONFIG.gammaBaseUrl);
  url.searchParams.set("series_id", String(seriesId));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("end_date_min", new Date(nowMs).toISOString());
  url.searchParams.set("order", "endDate");
  url.searchParams.set("ascending", "true");
  url.searchParams.set("limit", String(limit));
  const data = await getJson(url);
  return Array.isArray(data) ? data : [];
}

/**
 * Convert a Gamma market into the round descriptor the engine uses.
 * Returns null when token ids for both outcomes can't be found.
 */
export function roundFromMarket(market, { upLabel = CONFIG.polymarket.upOutcomeLabel, downLabel = CONFIG.polymarket.downOutcomeLabel } = {}) {
  if (!market) return null;
  const outcomes = parseMaybeJsonArray(market.outcomes).map((o) => String(o).toLowerCase());
  const tokens = parseMaybeJsonArray(market.clobTokenIds).map(String);
  const upIdx = outcomes.indexOf(upLabel.toLowerCase());
  const downIdx = outcomes.indexOf(downLabel.toLowerCase());
  if (upIdx < 0 || downIdx < 0 || !tokens[upIdx] || !tokens[downIdx]) return null;
  const endMs = timeMs(market.endDate);
  const startMs = timeMs(market.eventStartTime) ?? (endMs ? endMs - ROUND_SECONDS * 1000 : null);
  if (!startMs || !endMs) return null;
  const minSize = Number(market.orderMinSize);
  const tick = Number(market.orderPriceMinTickSize);
  return {
    slug: String(market.slug),
    question: String(market.question ?? ""),
    startMs,
    endMs,
    upTokenId: tokens[upIdx],
    downTokenId: tokens[downIdx],
    feeSchedule: normalizeFeeSchedule(market.feeSchedule),
    minOrderSize: Number.isFinite(minSize) && minSize > 0 ? minSize : 5,
    tickSize: Number.isFinite(tick) && tick > 0 ? tick : 0.01,
    negRisk: Boolean(market.negRisk)
  };
}

/** Find the round live at `nowMs`: try the deterministic slug first, then search the series. */
export async function fetchCurrentRound(nowMs = Date.now()) {
  if (CONFIG.polymarket.marketSlug) {
    const ev = await fetchEventBySlug(CONFIG.polymarket.marketSlug);
    return roundFromMarket(ev?.markets?.[0]);
  }
  try {
    const ev = await fetchEventBySlug(slugForTime(nowMs));
    const r = roundFromMarket(ev?.markets?.[0]);
    if (r && r.startMs <= nowMs && nowMs < r.endMs) return r;
  } catch {
    // fall through to series search
  }
  if (!CONFIG.polymarket.autoSelectLatest) return null;
  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, nowMs });
  const rounds = events
    .flatMap((e) => (Array.isArray(e.markets) ? e.markets : []))
    .map((m) => roundFromMarket(m))
    .filter((r) => r && r.startMs <= nowMs && nowMs < r.endMs)
    .sort((a, b) => a.endMs - b.endMs);
  return rounds[0] ?? null;
}

export async function fetchOrderBook(tokenId, depth = 10) {
  const url = new URL("/book", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);
  return normalizeBook(await getJson(url), depth);
}

/**
 * Parse the official outcome of a closed round from its Gamma event.
 * @returns {{ status: "resolved", outcome: "UP"|"DOWN", ptb: number|null, final: number|null } | { status: "pending" }}
 */
export function parseResolution(event, { upLabel = CONFIG.polymarket.upOutcomeLabel, downLabel = CONFIG.polymarket.downOutcomeLabel } = {}) {
  const market = event?.markets?.[0];
  if (!market || !market.closed) return { status: "pending" };
  const outcomes = parseMaybeJsonArray(market.outcomes).map((o) => String(o).toLowerCase());
  const prices = parseMaybeJsonArray(market.outcomePrices).map(Number);
  const winIdx = prices.findIndex((p) => p >= 0.99);
  if (winIdx < 0 || !outcomes[winIdx]) return { status: "pending" };
  const label = outcomes[winIdx];
  const outcome = label === upLabel.toLowerCase() ? "UP" : label === downLabel.toLowerCase() ? "DOWN" : null;
  if (!outcome) return { status: "pending" };
  const meta = event.eventMetadata ?? {};
  const ptb = Number(meta.priceToBeat);
  const final = Number(meta.finalPrice);
  return {
    status: "resolved",
    outcome,
    ptb: Number.isFinite(ptb) ? ptb : null,
    final: Number.isFinite(final) ? final : null
  };
}

export async function fetchResolution(slug) {
  const ev = await fetchEventBySlug(slug);
  if (!ev) return { status: "pending" };
  return parseResolution(ev);
}
