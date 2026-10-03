/**
 * Deribit option implied-vol surface (public API, no key).
 * GET /api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option
 * → result[]: { instrument_name: "BTC-3OCT26-118000-C", mark_iv: 45.2 (percent), underlying_price, ... }
 * Deribit options expire 08:00 UTC on the date in the instrument name.
 */
import { MS_PER_YEAR } from "./math.js";

const DERIBIT_BASE = process.env.DERIBIT_BASE_URL || "https://www.deribit.com";
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

export function parseInstrumentName(name) {
  const m = /^([A-Z_]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\d.d]+)-([CP])$/.exec(String(name || ""));
  if (!m) return null;
  const month = MONTHS[m[3]];
  if (month === undefined) return null;
  const strike = Number(m[5].replace("d", "."));
  if (!Number.isFinite(strike)) return null;
  return {
    currency: m[1],
    expiryMs: Date.UTC(2000 + Number(m[4]), month, Number(m[2]), 8, 0, 0),
    strike,
    type: m[6]
  };
}

/** Build { expiries: [{ expiryMs, forward, points: [{ x: ln(K/F), iv }] }] } sorted by expiry. */
export function buildSurface(summaries, nowMs = Date.now()) {
  const byExpiry = new Map();
  for (const s of Array.isArray(summaries) ? summaries : []) {
    const inst = parseInstrumentName(s?.instrument_name);
    const iv = Number(s?.mark_iv);
    const fwd = Number(s?.underlying_price);
    if (!inst || !(iv > 0) || !(fwd > 0) || inst.expiryMs <= nowMs) continue;
    let e = byExpiry.get(inst.expiryMs);
    if (!e) {
      e = { expiryMs: inst.expiryMs, forwards: [], byStrike: new Map() };
      byExpiry.set(inst.expiryMs, e);
    }
    e.forwards.push(fwd);
    const ivs = e.byStrike.get(inst.strike) ?? [];
    ivs.push(iv / 100);
    e.byStrike.set(inst.strike, ivs);
  }
  const expiries = [];
  for (const e of byExpiry.values()) {
    const forward = e.forwards.reduce((a, b) => a + b, 0) / e.forwards.length;
    const points = [...e.byStrike.entries()]
      .map(([k, ivs]) => ({ x: Math.log(k / forward), iv: ivs.reduce((a, b) => a + b, 0) / ivs.length }))
      .sort((a, b) => a.x - b.x);
    if (points.length >= 2) expiries.push({ expiryMs: e.expiryMs, forward, points });
  }
  expiries.sort((a, b) => a.expiryMs - b.expiryMs);
  return { expiries, builtAtMs: nowMs };
}

function smileIv(expiry, strike) {
  const x = Math.log(strike / expiry.forward);
  const pts = expiry.points;
  if (x <= pts[0].x) return pts[0].iv;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].iv;
  for (let i = 1; i < pts.length; i += 1) {
    if (x <= pts[i].x) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.iv + ((b.iv - a.iv) * (x - a.x)) / (b.x - a.x);
    }
  }
  return pts[pts.length - 1].iv;
}

/** Implied vol at (strike, target time): smile interpolation in log-moneyness, total-variance interpolation in time. */
export function surfaceIv(surface, strike, targetMs, nowMs = Date.now()) {
  const exps = surface?.expiries ?? [];
  if (!exps.length || !(strike > 0)) return null;
  if (targetMs <= exps[0].expiryMs) return smileIv(exps[0], strike);
  const last = exps[exps.length - 1];
  if (targetMs >= last.expiryMs) return smileIv(last, strike);
  for (let i = 1; i < exps.length; i += 1) {
    if (targetMs <= exps[i].expiryMs) {
      const e1 = exps[i - 1];
      const e2 = exps[i];
      const t1 = (e1.expiryMs - nowMs) / MS_PER_YEAR;
      const t2 = (e2.expiryMs - nowMs) / MS_PER_YEAR;
      const t = (targetMs - nowMs) / MS_PER_YEAR;
      const w1 = smileIv(e1, strike) ** 2 * t1;
      const w2 = smileIv(e2, strike) ** 2 * t2;
      const w = w1 + ((w2 - w1) * (t - t1)) / (t2 - t1);
      return w > 0 && t > 0 ? Math.sqrt(w / t) : smileIv(e1, strike);
    }
  }
  return smileIv(last, strike);
}

const cache = new Map();

/** Cached surface for BTC / ETH. Returns null for currencies Deribit does not list or on error. */
export async function getSurface(currency, { maxAgeMs = 5 * 60_000 } = {}) {
  const key = String(currency).toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.builtAtMs < maxAgeMs) return hit;
  const url = new URL("/api/v2/public/get_book_summary_by_currency", DERIBIT_BASE);
  url.searchParams.set("currency", key);
  url.searchParams.set("kind", "option");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Deribit ${key} error: ${res.status}`);
  const data = await res.json();
  const surface = buildSurface(data?.result);
  if (!surface.expiries.length) return null;
  cache.set(key, surface);
  return surface;
}
