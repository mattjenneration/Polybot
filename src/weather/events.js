/**
 * Polymarket daily temperature events ("Highest temperature in NYC on October 5?", "Lowest temperature in
 * London on …"). Each event is a set of mutually exclusive bucket markets (negRisk), so it's parsed and priced
 * as one distribution.
 *
 * Resolution (verified against 574 resolved markets, 99.8% match):
 *  - NOAA timeseries / Wunderground stations: max (or min) of the METAR reports (routine + specials) in the
 *    station's local calendar day, rounded to a whole degree → rule "round".
 *  - Hong Kong Observatory: absolute daily max/min at 0.1 °C, truncated to the whole degree → rule "floor".
 * Markets keep trading through the target day, well past Gamma's endDate (12:00 UTC on that day).
 */
import { CONFIG } from "../config.js";
import { normalizeGammaMarket, parseResolution } from "../markets/gamma.js";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const fetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url.pathname ?? url} → HTTP ${res.status}`);
  return res.json();
};

/** Bucket from "74-75°F", "73°F or below", "84°F or higher", "15°C", "-3--2°C". Inclusive integers; null = open. */
export function parseBucket(text) {
  const s = String(text || "").replace(/º/g, "°");
  let m = /(-?\d+)\s*(?:-|–|to)\s*(-?\d+)\s*°\s*([FC])/i.exec(s);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]), unit: m[3].toUpperCase() };
  m = /(-?\d+)\s*°\s*([FC])\s*or\s*(below|lower|less|under)/i.exec(s);
  if (m) return { lo: null, hi: Number(m[1]), unit: m[2].toUpperCase() };
  m = /(-?\d+)\s*°\s*([FC])\s*or\s*(higher|above|more|over)/i.exec(s);
  if (m) return { lo: Number(m[1]), hi: null, unit: m[2].toUpperCase() };
  m = /(-?\d+)\s*°\s*([FC])\b/i.exec(s);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]), unit: m[2].toUpperCase() };
  return null;
}

/** Resolution station and rule from an event description. */
export function parseResolutionSource(description) {
  const d = String(description || "");
  if (/Hong Kong Observatory/i.test(d)) return { station: "HKO", source: "hko", rule: "floor" };
  const ts = /timeseries\?site=([A-Za-z0-9]{3,5})/.exec(d);
  const wu = /wunderground\.com\/history\/daily\/[^\s"')]*?\/([A-Z0-9]{4})(?=[^A-Za-z0-9]|$)/.exec(d);
  const station = (ts?.[1] ?? wu?.[1])?.toUpperCase();
  if (!station) return null;
  return { station, source: "metar", rule: /one decimal place/i.test(d) ? "floor" : "round" };
}

/** "on October 5" → "YYYY-MM-DD", year chosen closest to `refMs`. */
export function parseTargetDate(text, refMs) {
  const m = new RegExp(String.raw`\b(${MONTHS.join("|")})\s+(\d{1,2})\b`, "i").exec(String(text || ""));
  if (!m || !refMs) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const refYear = new Date(refMs).getUTCFullYear();
  let best = null;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const t = Date.UTC(y, month, day);
    if (best === null || Math.abs(t - refMs) < Math.abs(best - refMs)) best = t;
  }
  return new Date(best).toISOString().slice(0, 10);
}

const num = (x) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

/** Raw Gamma event → normalized temperature event, or null if it isn't one we can model. */
export function parseTemperatureEvent(e) {
  const title = String(e?.title ?? "");
  const t = /^(Highest|Lowest) temperature in (.+?) on (.+?)\??$/i.exec(title.trim());
  if (!t) return null;
  const kind = t[1].toLowerCase() === "highest" ? "high" : "low";
  const city = t[2].trim();
  const res = parseResolutionSource(e.description);
  const endMs = e.endDate ? Date.parse(e.endDate) : null;
  const date = parseTargetDate(t[3], endMs ?? Date.now());
  if (!res || !date) return null;

  const buckets = [];
  for (const raw of Array.isArray(e.markets) ? e.markets : []) {
    const m = normalizeGammaMarket(raw, e);
    if (!m) continue;
    const b = parseBucket(m.groupItemTitle) ?? parseBucket(m.question);
    if (!b) continue;
    const resolution = parseResolution(raw);
    buckets.push({
      marketId: m.id,
      label: m.groupItemTitle || `${b.lo ?? ""}..${b.hi ?? ""}`,
      lo: b.lo,
      hi: b.hi,
      unit: b.unit,
      yesTokenId: m.yesTokenId,
      noTokenId: m.noTokenId,
      tick: num(raw.orderPriceMinTickSize) ?? 0.01,
      minSize: num(raw.orderMinSize) ?? 5,
      feeSchedule: m.feeSchedule,
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
      lastTrade: num(raw.lastTradePrice),
      volume: num(raw.volumeNum) ?? 0,
      closed: m.closed,
      accepting: m.acceptingOrders && !m.closed,
      yesWon: resolution.resolved ? resolution.yesWon : null
    });
  }
  if (buckets.length < 2) return null;
  const unit = buckets[0].unit;
  if (buckets.some((b) => b.unit !== unit)) return null;
  buckets.sort((a, b) => (a.lo ?? -Infinity) - (b.lo ?? -Infinity));

  return {
    id: String(e.id),
    slug: String(e.slug ?? ""),
    title,
    city,
    kind,
    date,
    unit,
    ...res,
    key: `${res.station}|${kind}|${date}`,
    endMs,
    closed: Boolean(e.closed),
    volume: num(e.volume) ?? 0,
    liquidity: num(e.liquidity) ?? 0,
    buckets
  };
}

/**
 * Open temperature events for the configured tags. `lookbackMs` keeps events whose Gamma endDate has passed
 * (it's 12:00 UTC on the target day) but which are still trading or awaiting resolution.
 */
export async function fetchTemperatureEvents({ tags = ["daily-temperature"], lookbackMs = 4 * 86_400_000, maxPages = 10, pageSize = 100 } = {}) {
  const byId = new Map();
  let unparsed = 0;
  for (const tag of tags) {
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL("/events", CONFIG.gammaBaseUrl);
      url.searchParams.set("tag_slug", tag);
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(page * pageSize));
      url.searchParams.set("end_date_min", new Date(Date.now() - lookbackMs).toISOString());
      const events = await fetchJson(url);
      if (!Array.isArray(events) || !events.length) break;
      for (const raw of events) {
        const ev = parseTemperatureEvent(raw);
        if (ev) byId.set(ev.id, ev);
        else if (/temperature in/i.test(raw?.title ?? "")) unparsed += 1;
      }
      if (events.length < pageSize) break;
    }
  }
  return { events: [...byId.values()], unparsed };
}

/** Current state of one event (used for settlement). Returns the parsed event or null. */
export async function fetchEventBySlug(slug) {
  const url = new URL("/events", CONFIG.gammaBaseUrl);
  url.searchParams.set("slug", slug);
  const arr = await fetchJson(url);
  return Array.isArray(arr) && arr[0] ? parseTemperatureEvent(arr[0]) : null;
}

/**
 * Settlement status of a parsed event: "resolved" (exactly one bucket won), "void" (all buckets closed, none
 * won), or "open".
 */
export function eventResolution(ev) {
  if (!ev) return { status: "open" };
  const winners = ev.buckets.filter((b) => b.yesWon === true);
  if (winners.length === 1 && ev.buckets.every((b) => b.yesWon !== null || b.closed)) {
    return { status: "resolved", winnerMarketId: winners[0].marketId, winnerLabel: winners[0].label };
  }
  if (ev.buckets.every((b) => b.closed) && winners.length === 0 && ev.buckets.every((b) => b.yesWon === false)) {
    return { status: "void" };
  }
  return { status: "open" };
}
