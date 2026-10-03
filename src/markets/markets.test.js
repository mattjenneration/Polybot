import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "markets-test-"));
process.env.MARKETS_LOG_DIR = TMP;

const { normCdf, probAbove, probTouch } = await import("./math.js");
const { parseInstrumentName, buildSurface, surfaceIv } = await import("./deribit.js");
const { parseCryptoMarket, priceContract } = await import("./cryptoLadder.js");
const { parseBucket, parseStation, parseTargetDate, parseWeatherMarket, buildDayDistribution, bucketProbability, metarTempC } = await import("./weather.js");
const { normalizeGammaMarket, parseResolution } = await import("./gamma.js");
const { decideEntry, createLedger } = await import("./paperLedger.js");
const { getFeeSchedule } = await import("../simulation/fills.js");

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const deribitName = (ms, k, t) => {
  const d = new Date(ms);
  return `BTC-${d.getUTCDate()}${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}-${k}-${t}`;
};

test("math: normal cdf and lognormal probabilities", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  const p = probAbove({ spot: 100, strike: 100, sigma: 0.5, tYears: 1 / 365 });
  assert.ok(p < 0.5 && p > 0.49);
  assert.ok(probAbove({ spot: 100, strike: 130, sigma: 0.5, tYears: 1 / 365 }) < 0.001);
  assert.equal(probTouch({ spot: 100, barrier: 100, sigma: 0.5, tYears: 0.1 }), 1);
  // touch prob ≈ 2 × terminal prob for out-of-the-money barrier
  const pt = probTouch({ spot: 100, barrier: 110, sigma: 0.5, tYears: 0.1 });
  const pa = probAbove({ spot: 100, strike: 110, sigma: 0.5, tYears: 0.1 });
  assert.ok(pt > 1.8 * pa && pt < 2.4 * pa);
});

test("deribit: instrument parsing and surface interpolation", () => {
  const inst = parseInstrumentName("BTC-3OCT26-118000-C");
  assert.equal(inst.strike, 118000);
  assert.equal(inst.expiryMs, Date.UTC(2026, 9, 3, 8));
  const now = Date.UTC(2026, 9, 1, 0);
  const e1 = Date.UTC(2026, 9, 2, 8);
  const e2 = Date.UTC(2026, 9, 9, 8);
  const rows = [];
  for (const [e, iv] of [[e1, 40], [e2, 60]]) {
    for (const k of [100000, 120000, 140000]) rows.push({ instrument_name: deribitName(e, k, "C"), mark_iv: iv + (k === 120000 ? 0 : 10), underlying_price: 120000 });
  }
  const s = buildSurface(rows, now);
  assert.equal(s.expiries.length, 2);
  assert.ok(Math.abs(surfaceIv(s, 120000, e1, now) - 0.4) < 1e-9);
  assert.ok(surfaceIv(s, 130000, e1, now) > 0.4 && surfaceIv(s, 130000, e1, now) < 0.5);
  const mid = surfaceIv(s, 120000, (e1 + e2) / 2, now);
  assert.ok(mid > 0.4 && mid < 0.6);
});

test("crypto: question parsing", () => {
  const end = Date.UTC(2026, 9, 4, 16);
  const mk = (question, extra = {}) => ({ question, endMs: end, eventStartMs: null, ...extra });
  assert.deepEqual(parseCryptoMarket(mk("Will the price of Bitcoin be above $118,000 on October 4?")), { asset: "BTC", expiryMs: end, kind: "above", lo: 118000 });
  assert.equal(parseCryptoMarket(mk("Will the price of Ethereum be between $4,200 and $4,400 on October 4?")).kind, "between");
  assert.equal(parseCryptoMarket(mk("Will the price of Bitcoin be less than $100k on October 4?")).lo, 100000);
  assert.equal(parseCryptoMarket(mk("Will Bitcoin reach $150,000 in October?")).kind, "touch_up");
  assert.equal(parseCryptoMarket(mk("Will Bitcoin dip to $90,000 in October?")).kind, "touch_down");
  assert.equal(parseCryptoMarket(mk("Bitcoin Up or Down - October 4, 9AM ET", { eventStartMs: end - 3_600_000 })).kind, "updown");
  assert.equal(parseCryptoMarket(mk("Bitcoin Up or Down - 5 minutes", { eventStartMs: end - 300_000 })), null);
  assert.equal(parseCryptoMarket(mk("Will Bitcoin dominance be above 60% on October 4?")), null);
  assert.equal(parseCryptoMarket(mk("Will ETH flip BTC?")), null);
});

test("crypto: between buckets of a full ladder sum to 1", () => {
  const now = Date.UTC(2026, 9, 3, 12);
  const expiryMs = now + 86_400_000;
  const ivAt = () => 0.5;
  const edges = [100000, 110000, 115000, 120000, 125000, 130000, 140000];
  let total = priceContract({ kind: "below", lo: edges[0], expiryMs }, { spot: 118000, ivAt, nowMs: now });
  for (let i = 1; i < edges.length; i += 1) total += priceContract({ kind: "between", lo: edges[i - 1], hi: edges[i], expiryMs }, { spot: 118000, ivAt, nowMs: now });
  total += priceContract({ kind: "above", lo: edges[edges.length - 1], expiryMs }, { spot: 118000, ivAt, nowMs: now });
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("weather: bucket / station / date parsing", () => {
  assert.deepEqual(parseBucket("74-75°F"), { lo: 74, hi: 75, unit: "F" });
  assert.deepEqual(parseBucket("73°F or below"), { lo: null, hi: 73, unit: "F" });
  assert.deepEqual(parseBucket("84°F or higher"), { lo: 84, hi: null, unit: "F" });
  assert.deepEqual(parseBucket("15°C"), { lo: 15, hi: 15, unit: "C" });
  assert.deepEqual(parseBucket("-2°C or below"), { lo: null, hi: -2, unit: "C" });
  assert.equal(parseStation("Resolves per https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA."), "KLGA");
  assert.equal(parseStation("recorded at the London City Airport Station"), "EGLC");
  assert.equal(parseTargetDate("Highest temperature in NYC on October 3?", Date.UTC(2026, 9, 4)), "2026-10-03");
  assert.equal(parseTargetDate("on December 31?", Date.UTC(2027, 0, 1)), "2026-12-31");
  assert.equal(metarTempC({ rawOb: "KLGA 031651Z 18008KT 10SM FEW250 26/14 A3012 RMK AO2 T02560139", temp: 26 }), 25.6);
  assert.equal(metarTempC({ rawOb: "X T10120020", temp: -1 }), -1.2);
});

/** Synthetic Open-Meteo ensemble for NYC (EDT, UTC−4): 3 members peaking at 15:00 local at 72/73/74°F. */
function nycForecast() {
  const time = [];
  const members = [[], [], []];
  for (let d = 2; d <= 5; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      time.push(`2026-10-0${d}T${String(h).padStart(2, "0")}:00`);
      const shape = Math.max(0, 1 - Math.abs(h - 15) / 9);
      members.forEach((arr, i) => arr.push(60 + (12 + i) * shape));
    }
  }
  return {
    utc_offset_seconds: -14400,
    hourly: {
      time,
      temperature_2m_member01_ecmwf_ifs025: members[0],
      temperature_2m_member02_ecmwf_ifs025: members[1],
      temperature_2m_gfs025: members[2]
    }
  };
}

test("weather: day distribution with observations floors and bias-corrects", () => {
  const nowMs = Date.UTC(2026, 9, 3, 16); // 12:00 EDT
  const metars = [
    { obsTime: Date.UTC(2026, 9, 3, 14) / 1000, temp: 20, rawOb: "KLGA T02000100" }, // 10:00 local, 68.0F
    { obsTime: Date.UTC(2026, 9, 3, 15, 51) / 1000, temp: 21, rawOb: "KLGA T02110100" } // 11:51 local, 69.98F
  ];
  const dist = buildDayDistribution({ forecast: nycForecast(), metars, date: "2026-10-03", unit: "F", nowMs });
  assert.equal(dist.members.length, 3);
  assert.ok(Math.abs(dist.obsMax - 69.98) < 1e-6);
  assert.ok(dist.bias > 0 && dist.bias < 6); // obs warmer than ensemble mean at noon
  assert.ok(dist.hoursAhead > 2.5 && dist.hoursAhead < 3.5);

  const buckets = [[null, 69], [70, 71], [72, 73], [74, 75], [76, 77], [78, null]];
  const ps = buckets.map(([lo, hi]) => bucketProbability({ members: dist.members, obsMax: dist.obsMax, sigma: 1.2, lo, hi }));
  assert.ok(Math.abs(ps.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(ps[0] < 1e-9, "max can't finish below an already-observed 70F");

  // Day over: no remaining hours → deterministic around observed max
  const late = buildDayDistribution({ forecast: nycForecast(), metars, date: "2026-10-03", unit: "F", nowMs: Date.UTC(2026, 9, 4, 5) });
  assert.equal(late.members.length, 0);
  assert.ok(bucketProbability({ members: [], obsMax: late.obsMax, sigma: 0.3, lo: 70, hi: 71 }) > 0.9); // 69.98F sits near the 69/70 rounding edge
});

test("gamma: market normalization and resolution parsing", () => {
  const raw = { id: 7, question: "Q", outcomes: "[\"Yes\",\"No\"]", clobTokenIds: "[\"a\",\"b\"]", endDate: "2026-10-04T16:00:00Z", closed: true, outcomePrices: "[\"0\",\"1\"]" };
  const m = normalizeGammaMarket(raw);
  assert.equal(m.yesTokenId, "a");
  assert.deepEqual(parseResolution(raw), { resolved: true, yesWon: false });
  assert.deepEqual(parseResolution({ ...raw, closed: false }), { resolved: false });
  assert.equal(normalizeGammaMarket({ ...raw, outcomes: "[\"A\",\"B\",\"C\"]" }), null);
});

test("entry rule: takes the side with fee-adjusted edge, walks only while edge holds", () => {
  const feeSchedule = getFeeSchedule("crypto");
  const d = decideEntry({
    p: 0.02,
    yesAsks: [{ price: "0.05", size: "1000" }],
    noAsks: [{ price: "0.85", size: "5" }, { price: "0.90", size: "5" }, { price: "0.95", size: "1000" }],
    feeSchedule,
    minEdge: 0.06,
    betUsd: 20
  });
  assert.equal(d.action, "enter");
  assert.equal(d.side, "NO");
  assert.ok(d.limit < 0.95 && d.limit >= 0.9);
  assert.equal(d.fill.status, "partial"); // 0.95 level fails the edge test
  assert.ok(Math.abs(d.fill.shares - 10) < 1e-9);
  assert.equal(decideEntry({ p: 0.5, yesAsks: [{ price: 0.5, size: 100 }], noAsks: [{ price: 0.52, size: 100 }], feeSchedule, minEdge: 0.06, betUsd: 10 }).reason, "edge_below_min");
});

test("end-to-end: discover → price → paper trade → settle on a mocked network", async () => {
  const nowMs = Date.now();
  const end = nowMs + 20 * 3_600_000;
  const e1 = Math.ceil(nowMs / 86_400_000) * 86_400_000 + 8 * 3_600_000 + 86_400_000;
  const deribitRows = [];
  for (const e of [e1, e1 + 7 * 86_400_000]) {
    for (const k of [100000, 110000, 120000, 130000, 140000]) {
      deribitRows.push({ instrument_name: deribitName(e, k, "C"), mark_iv: 45, underlying_price: 120000 });
    }
  }
  const cryptoEvent = {
    slug: "bitcoin-above-on-x",
    title: "Bitcoin above ___?",
    markets: [
      { id: "101", question: "Will the price of Bitcoin be above $130,000 on October 4?", slug: "btc-130k", outcomes: "[\"Yes\",\"No\"]", clobTokenIds: "[\"y101\",\"n101\"]", endDate: new Date(end).toISOString(), active: true, closed: false, enableOrderBook: true, acceptingOrders: true, bestBid: 0.12, bestAsk: 0.14 },
      { id: "102", question: "Will the price of Bitcoin be above $120,000 on October 4?", slug: "btc-120k", outcomes: "[\"Yes\",\"No\"]", clobTokenIds: "[\"y102\",\"n102\"]", endDate: new Date(end).toISOString(), active: true, closed: false, enableOrderBook: true, acceptingOrders: true, bestBid: 0.48, bestAsk: 0.5 },
      { id: "103", question: "Bitcoin Up or Down - 5 minutes", slug: "btc-5m", outcomes: "[\"Up\",\"Down\"]", clobTokenIds: "[\"u\",\"d\"]", endDate: new Date(nowMs + 300_000).toISOString(), eventStartTime: new Date(nowMs).toISOString(), active: true, closed: false, enableOrderBook: true }
    ]
  };
  const books = {
    y101: [{ price: "0.14", size: "500" }],
    n101: [{ price: "0.88", size: "500" }],
    y102: [{ price: "0.50", size: "500" }],
    n102: [{ price: "0.52", size: "500" }]
  };
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push(`${opts.method ?? "GET"} ${u.host}${u.pathname}`);
    const json = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    if (u.pathname === "/events") return json(u.searchParams.get("tag_slug") === "crypto" && u.searchParams.get("offset") === "0" ? [cryptoEvent] : []);
    if (u.pathname === "/api/v3/ticker/price") return json({ price: "120000" });
    if (u.pathname.endsWith("get_book_summary_by_currency")) return json({ result: deribitRows });
    if (u.pathname === "/books") return json(JSON.parse(opts.body).map(({ token_id }) => ({ asset_id: token_id, asks: books[token_id] ?? [], bids: [] })));
    if (u.pathname === "/markets/101") return json({ id: "101", outcomes: "[\"Yes\",\"No\"]", clobTokenIds: "[\"y101\",\"n101\"]", closed: true, outcomePrices: "[\"0\",\"1\"]" });
    if (u.pathname.startsWith("/markets/")) return json({ id: "x", outcomes: "[\"Yes\",\"No\"]", clobTokenIds: "[\"a\",\"b\"]", closed: false, outcomePrices: "[\"0.5\",\"0.5\"]" });
    return { ok: false, status: 404, json: async () => ({}), text: async () => "nf" };
  };

  const { createCryptoLadderModule } = await import("./cryptoLadder.js");
  const { runModule, settle } = await import("./runner.js");
  const mod = { ...createCryptoLadderModule({ tags: ["crypto"] }), cfg: { minEdge: 0.06, minMinutesToExpiry: 15 } };
  const ledger = createLedger({ modules: ["crypto_ladder"], budgetUsd: 100 });
  const st = await runModule(mod, ledger, new Map(), nowMs);
  assert.equal(st.parsed, 2); // 5m up/down excluded
  assert.equal(st.priced, 2);
  assert.equal(st.entered, 1); // only the 130k NO is mispriced
  const pos = ledger.state().positions[0];
  assert.equal(pos.marketId, "101");
  assert.equal(pos.side, "NO");
  assert.ok(Math.abs(pos.totalUsd - 10) < 1e-6);

  await settle(ledger, end + 10 * 60_000);
  const sum = ledger.summary()[0];
  assert.equal(sum.settled, 1);
  assert.equal(sum.wins, 1);
  assert.ok(sum.realizedPnlUsd > 1 && sum.realizedPnlUsd < 1.4); // 10/0.88 shares − $10 − nothing extra
  ledger.save();
  assert.ok(fs.existsSync(path.join(TMP, "markets_state.json")));
  for (const f of ["markets_trades.csv", "markets_settlements.csv", "markets_snapshots.csv", "markets_resolutions.csv"]) {
    assert.ok(fs.existsSync(path.join(TMP, f)), f);
  }
  assert.ok(calls.some((c) => c.includes("deribit")));
});

test("weather module parses a realistic market", () => {
  const m = parseWeatherMarket({
    eventTitle: "Highest temperature in NYC on October 3?",
    question: "Will the highest temperature in New York City be between 74-75°F on October 3?",
    groupItemTitle: "74-75°F",
    description: "This market resolves based on the highest temperature recorded at the LaGuardia Airport Station (https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA).",
    endMs: Date.UTC(2026, 9, 4, 12)
  });
  assert.deepEqual(m, { lo: 74, hi: 75, unit: "F", station: "KLGA", date: "2026-10-03" });
});
