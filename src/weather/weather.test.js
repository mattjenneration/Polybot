import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "weather-test-"));
process.env.WEATHER_LOG_DIR = TMP;

const { localDayBounds, leadBinFor, localDate } = await import("./time.js");
const { parseBucket, parseResolutionSource, parseTemperatureEvent, eventResolution } = await import("./events.js");
const dist = await import("./model/distribution.js");
const { buildForecast, summarizeObs, realizedExtreme } = await import("./model/forecast.js");
const { createSkillTracker, PRIOR_SD_C } = await import("./model/skill.js");
const { createCalibrator, calibratorFeatures } = await import("./model/calibrator.js");
const { marketView, mirrorBook } = await import("./model/market.js");
const { createReturnStats, createVariantChooser, cityPolicy, createFillModel, createExpertMixer } = await import("./strategy/learning.js");
const { decideEvent } = await import("./strategy/decide.js");
const { buildShadowVariants, WEATHER_STRATEGIES } = await import("./strategy/strategies.js");
const { createWeatherEngine } = await import("./engine.js");
const { learnFromHistory } = await import("./backfill.js");
const { applyObsVeto } = await import("./runner.js");
const { WCFG } = await import("./config.js");

const NY = "America/New_York";
const FEE = { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25 };

// ---------------------------------------------------------------------------------------------- time
test("time: DST-safe local days and lead bins", () => {
  const nov1 = localDayBounds("2026-11-01", NY); // US DST ends → 25-hour day
  assert.equal((nov1.endMs - nov1.startMs) / 3_600_000, 25);
  const oct5 = localDayBounds("2026-10-05", NY);
  assert.equal(oct5.startMs, Date.UTC(2026, 9, 5, 4));
  const now = Date.UTC(2026, 9, 5, 14); // 10:00 EDT
  assert.equal(localDate(now, NY), "2026-10-05");
  assert.equal(leadBinFor("2026-10-05", NY, now), "d0a");
  assert.equal(leadBinFor("2026-10-05", NY, Date.UTC(2026, 9, 5, 21)), "d0b"); // 17:00 EDT, 7h left
  assert.equal(leadBinFor("2026-10-05", NY, Date.UTC(2026, 9, 6, 2, 30)), "d0d"); // 22:30 EDT
  assert.equal(leadBinFor("2026-10-06", NY, now), "d1");
  assert.equal(leadBinFor("2026-10-07", NY, now), "d2");
  assert.equal(leadBinFor("2026-10-04", NY, now), "post");
});

// ---------------------------------------------------------------------------------------------- parsing
function gammaMarket(id, label, extra = {}) {
  return {
    id: String(id), question: `Will the highest temperature be ${label}?`, groupItemTitle: label, outcomes: "[\"Yes\",\"No\"]",
    clobTokenIds: JSON.stringify([`y${id}`, `n${id}`]), active: true, closed: false, enableOrderBook: true, acceptingOrders: true,
    orderPriceMinTickSize: 0.01, orderMinSize: 5, feeSchedule: FEE, ...extra
  };
}
const NYC_DESC = "This market will resolve to the temperature range that contains the highest temperature recorded by NOAA at the LaGuardia Airport Station in degrees Fahrenheit on 5 Oct '26. … https://www.weather.gov/wrh/timeseries?site=klga …";
const NYC_LABELS = ["65°F or below", "66-67°F", "68-69°F", "70-71°F", "72-73°F", "74-75°F", "76°F or higher"];
function nycEvent(marketExtra = () => ({})) {
  return {
    id: "900", slug: "highest-temperature-in-nyc-on-october-5-2026", title: "Highest temperature in NYC on October 5?",
    description: NYC_DESC, endDate: "2026-10-05T12:00:00Z", volume: 5000, liquidity: 30000,
    markets: NYC_LABELS.map((l, i) => gammaMarket(100 + i, l, marketExtra(i)))
  };
}

test("events: buckets, resolution sources, full event", () => {
  assert.deepEqual(parseBucket("74-75°F"), { lo: 74, hi: 75, unit: "F" });
  assert.deepEqual(parseBucket("-3--2°C"), { lo: -3, hi: -2, unit: "C" });
  assert.deepEqual(parseBucket("8°C or below"), { lo: null, hi: 8, unit: "C" });
  assert.deepEqual(parseBucket("18°C or higher"), { lo: 18, hi: null, unit: "C" });
  assert.deepEqual(parseBucket("15ºC"), { lo: 15, hi: 15, unit: "C" });
  assert.deepEqual(parseResolutionSource(NYC_DESC), { station: "KLGA", source: "metar", rule: "round" });
  assert.deepEqual(parseResolutionSource("Wunderground … https://www.wunderground.com/history/daily/tw/taipei/RCSS."), { station: "RCSS", source: "metar", rule: "round" });
  assert.deepEqual(parseResolutionSource("recorded by the Hong Kong Observatory … one decimal place"), { station: "HKO", source: "hko", rule: "floor" });

  const ev = parseTemperatureEvent(nycEvent());
  assert.equal(ev.city, "NYC");
  assert.equal(ev.kind, "high");
  assert.equal(ev.date, "2026-10-05");
  assert.equal(ev.station, "KLGA");
  assert.equal(ev.unit, "F");
  assert.equal(ev.buckets.length, 7);
  assert.equal(ev.buckets[0].lo, null);
  assert.equal(ev.buckets[6].hi, null);
  assert.equal(ev.buckets[1].yesTokenId, "y101");
  const low = parseTemperatureEvent({ ...nycEvent(), title: "Lowest temperature in Seoul (Incheon) on October 5?" });
  assert.equal(low.kind, "low");
  assert.equal(low.city, "Seoul (Incheon)");
  assert.equal(parseTemperatureEvent({ ...nycEvent(), title: "Precipitation in NYC in October?" }), null);

  assert.equal(eventResolution(ev).status, "open");
  const resolved = parseTemperatureEvent(nycEvent((i) => ({ closed: true, outcomePrices: i === 3 ? "[\"1\",\"0\"]" : "[\"0\",\"1\"]" })));
  assert.deepEqual(eventResolution(resolved), { status: "resolved", winnerMarketId: "103", winnerLabel: "70-71°F" });
});

// ---------------------------------------------------------------------------------------------- distribution
test("distribution: rounding vs HKO truncation, floors, ceilings", () => {
  const buckets = [{ lo: null, hi: 31 }, { lo: 32, hi: 32 }, { lo: 33, hi: 33 }, { lo: 34, hi: null }];
  assert.equal(dist.bucketIndexForValue(buckets, 33.6, "floor"), 2); // HKO 33.6 → "33°C" (verified on resolved markets)
  assert.equal(dist.bucketIndexForValue(buckets, 33.6, "round"), 3);
  assert.equal(dist.bucketIndexForValue(buckets, 32.96, "floor"), 2); // displays as 33.0

  const f = [{ lo: null, hi: 67 }, { lo: 68, hi: 69 }, { lo: 70, hi: 71 }, { lo: 72, hi: 73 }, { lo: 74, hi: null }];
  const remaining = dist.gaussianCdf(69, 1.5);
  const ps = dist.bucketProbs(f, remaining, "round");
  assert.ok(Math.abs(ps.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const floored = dist.bucketProbs(f, dist.dayExtremeCdf("high", 70.2, remaining), "round");
  assert.ok(floored[0] < 1e-12 && floored[1] < 1e-12, "a 70.2°F reading rules out ≤69");
  assert.ok(floored[2] > 0.6);
  assert.deepEqual(dist.impossibleBuckets(f, "high", 70.2, "round"), [true, true, false, false, false]);
  const ceiling = dist.bucketProbs(f, dist.dayExtremeCdf("low", 68.4, dist.gaussianCdf(71, 1.5)), "round");
  assert.ok(ceiling[2] < 1e-12 && ceiling[3] < 1e-12 && ceiling[4] < 1e-12, "a 68.4°F low rules out ≥70");
  assert.deepEqual(dist.impossibleBuckets(f, "low", 68.4, "round"), [false, false, true, true, true]);
  // fat tails: more mass 3σ out than a plain normal (0.00135), same overall sd
  assert.ok(1 - dist.tailNormCdf(3, 0, 1) > 0.004);
  assert.ok(Math.abs(dist.tailNormCdf(0, 0, 1) - 0.5) < 1e-9);
});

// ---------------------------------------------------------------------------------------------- forecast
function hourlyNY(date, shape) {
  const { startMs } = localDayBounds(date, NY);
  const times = [];
  const values = [];
  for (let h = -24; h <= 48; h += 1) {
    times.push(startMs + h * 3_600_000);
    const local = ((h % 24) + 24) % 24;
    values.push(shape(local));
  }
  return { times, values };
}
const diurnal = (min, max) => (h) => min + (max - min) * Math.max(0, Math.sin(((h - 6) / 18) * Math.PI));

test("forecast: debiased blend, observation floor, nowcast, post-day point mass", () => {
  const event = parseTemperatureEvent(nycEvent());
  const a = hourlyNY("2026-10-05", diurnal(60, 69));
  const b = hourlyNY("2026-10-05", diurnal(61, 71));
  const det = { times: a.times, models: { m1: a.values, m2: b.values } };
  const skill = createSkillTracker();
  // Both models historically 1.8°F (1°C) too cold at d1
  for (let i = 0; i < 40; i += 1) {
    skill.update("KLGA", "high", "model:m1", "d1", -1);
    skill.update("KLGA", "high", "model:m2", "d1", -1);
  }
  const dayBefore = Date.UTC(2026, 9, 4, 18);
  const fc = buildForecast({ event, tz: NY, det, ens: null, obsInfo: null, skill, nowMs: dayBefore });
  assert.equal(fc.ok, true);
  assert.equal(fc.leadBin, "d1");
  assert.ok(Math.abs(fc.pWx.reduce((x, y) => x + y, 0) - 1) < 1e-9);
  const rawMean = (Math.max(...a.values) + Math.max(...b.values)) / 2;
  assert.ok(fc.approaches.blend.mu > rawMean + 1.2, "cold bias corrected upward");
  assert.ok(fc.summary.mean > 70 && fc.summary.mean < 73);

  // Same day, 14:00 local, already 72.5°F observed and running 2°F above the models
  const noon = Date.UTC(2026, 9, 5, 18);
  const obs = [{ tMs: noon - 3_600_000, v: 71.0 }, { tMs: noon - 600_000, v: 72.5 }];
  const { startMs, endMs } = localDayBounds("2026-10-05", NY);
  const obsInfo = summarizeObs({ kind: "high", obs, startMs, endMs, nowMs: noon });
  assert.equal(obsInfo.ext, 72.5);
  const fc0 = buildForecast({ event, tz: NY, det, ens: null, obsInfo, skill, nowMs: noon });
  assert.equal(fc0.leadBin, "d0b");
  assert.ok(fc0.approaches.nowcast.err > 0, "observed warmer than models");
  assert.deepEqual(fc0.impossible.slice(0, 5), [true, true, true, true, false]); // 72.5 rules out ≤71
  assert.ok(fc0.pWx.slice(0, 4).reduce((x, y) => x + y, 0) < 1e-9);

  const after = Date.UTC(2026, 9, 6, 6);
  const fcPost = buildForecast({ event, tz: NY, det, ens: null, obsInfo: { ext: 73.4, n: 24, latest: null, complete: true }, skill, nowMs: after });
  assert.equal(fcPost.leadBin, "post");
  assert.ok(fcPost.pWx[4] > 0.98, "73.4 rounds into 72-73");
  assert.equal(realizedExtreme("high", [{ tMs: startMs + 1, v: 60 }, { tMs: startMs + 2 * 3_600_000, v: 65 }], startMs, endMs), null, "big gaps → unknown");
});

test("forecast: ensemble members debiased by their parent model", () => {
  const event = parseTemperatureEvent(nycEvent());
  const a = hourlyNY("2026-10-05", diurnal(60, 68));
  const skill = createSkillTracker();
  for (let i = 0; i < 40; i += 1) skill.update("KLGA", "high", "model:ecmwf_ifs025", "d1", -1.5); // 2.7°F cold
  const members = Array.from({ length: 10 }, (_, j) => a.values.map((v) => v + (j - 4.5) * 0.3));
  const ens = { times: a.times, members, groups: members.map(() => "ecmwf_ifs025_ensemble") };
  const fc = buildForecast({ event, tz: NY, det: null, ens, obsInfo: null, skill, nowMs: Date.UTC(2026, 9, 4, 18) });
  assert.ok(fc.approaches.ensemble.mu > 68 + 2.2, `members shifted warm (${fc.approaches.ensemble.mu})`);
  assert.deepEqual(fc.mixUsed, { gauss: 0, ens: 1 });
});

// ---------------------------------------------------------------------------------------------- skill
test("skill: hierarchical shrinkage and °F conversion", () => {
  const s = createSkillTracker({ priorWeight: 5 });
  assert.equal(s.get("X", "high", "blend", "d1").sd, PRIOR_SD_C.d1);
  for (let i = 0; i < 100; i += 1) s.update("A", "high", "blend", "d1", 2 + (i % 2 ? 0.5 : -0.5));
  const a = s.get("A", "high", "blend", "d1");
  assert.ok(a.bias > 1.85 && a.bias < 2.05);
  assert.ok(a.sd < 0.8);
  const b = s.get("B", "high", "blend", "d1"); // unseen station borrows the global record
  assert.ok(b.bias > 1.5 && b.n === 0);
  assert.equal(s.get("B", "high", "nowcast", "d1", { fallback: ["blend"] }).source, "blend");
});

// ---------------------------------------------------------------------------------------------- calibrator
test("calibrator: learns to trust the source that predicts outcomes", () => {
  const cal = createCalibrator({ learningRate: 0.2 });
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let e = 0; e < 300; e += 1) {
    const winner = Math.floor(rnd() * 5);
    const pWx = [0, 1, 2, 3, 4].map((i) => (i === winner ? 0.6 : 0.1)); // sharp and right
    const pMkt = [0.2, 0.2, 0.2, 0.2, 0.2]; // uninformative crowd
    cal.learnEvent([{ xs: calibratorFeatures({ pWx, pMkt, leadBin: "d1" }), pWx, pMkt, pFinal: pWx, leadBin: "d1" }], winner, "X|high");
  }
  const w = cal.weights();
  assert.ok(w.wx > 0.8, `wx weight ${w.wx}`);
  const sc = cal.scorecard();
  assert.ok(sc.all.logLoss.wx < sc.all.logLoss.mkt);
  assert.equal(sc.byCity["X|high"].n, 300);
  assert.deepEqual(applyObsVeto([0.5, 0.3, 0.2], [true, false, false]).map((x) => Number(x.toFixed(4))), [0.004, 0.5976, 0.3984]);
});

// ---------------------------------------------------------------------------------------------- market
test("market: mirrored NO book and implied distribution", () => {
  const no = mirrorBook({ bids: [[0.42, 100]], asks: [[0.44, 50]] });
  assert.deepEqual(no, { bids: [[0.56, 50]], asks: [[0.58, 100]] });
  const event = parseTemperatureEvent(nycEvent((i) => ({ bestBid: [null, 0.05, 0.3, 0.4, 0.15, 0.02, null][i], bestAsk: [0.01, 0.07, 0.33, 0.43, 0.18, 0.04, 0.01][i] })));
  const mv = marketView(event, new Map(), Date.now(), 60_000);
  assert.equal(mv.quality, "good");
  assert.ok(Math.abs(mv.pMkt.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(mv.pMkt.indexOf(Math.max(...mv.pMkt)), 3);
});

// ---------------------------------------------------------------------------------------------- learning
test("learning: LCB gating, Thompson choice, city policy, fills, expert mixer", () => {
  const stats = createReturnStats({ decay: 1 });
  for (let i = 0; i < 30; i += 1) {
    stats.record("good", 0.2 + (i % 2 ? 0.05 : -0.05));
    stats.record("bad", -0.1 + (i % 2 ? 0.05 : -0.05));
  }
  assert.ok(stats.summary("good").lcb > 0);
  assert.ok(stats.summary("bad").lcb < 0);
  const choose = createVariantChooser({ seed: 3 });
  const pick = choose([{ id: "good" }, { id: "bad" }, { id: "new" }], stats, { minEvents: 15, lcbZ: 1 });
  assert.equal(pick.variant.id, "good");
  assert.equal(choose([{ id: "bad" }], stats, { minEvents: 15, lcbZ: 1 }), null);
  assert.equal(cityPolicy(stats.summary("bad"), { minEvents: 15 }).mult, 0);
  assert.ok(cityPolicy(stats.summary("good"), { minEvents: 15 }).mult > 1.5);
  assert.deepEqual(cityPolicy(stats.summary("new"), { minEvents: 15 }), { mult: 1, status: "learning" });

  const fm = createFillModel();
  const p0 = fm.p(0.01, "d1");
  for (let i = 0; i < 20; i += 1) fm.record(0.01, "d1", true);
  assert.ok(fm.p(0.01, "d1") > p0);
  assert.ok(fm.p(0.08, "d1") < fm.p(0.01, "d1"));

  const mix = createExpertMixer();
  assert.deepEqual(mix.weights("d1"), { gauss: 0.5, ens: 0.5 });
  for (let i = 0; i < 10; i += 1) mix.record("d1", { gauss: 1.0, ens: 1.4 });
  assert.ok(mix.weights("d1").gauss > 0.9);
});

// ---------------------------------------------------------------------------------------------- decide
function ctxWith({ pFinal, pMkt, yesBooks, leadBin = "d1", bookRx = Date.now() }) {
  return {
    leadBin,
    probs: { final: pFinal, wx: pFinal, market: pMkt },
    buckets: yesBooks.map((yb, i) => ({ marketId: `m${i}`, label: `b${i}`, tick: 0.01, minSize: 5, feeSchedule: FEE, bookRx, yes: yb, no: yb && mirrorBook(yb) }))
  };
}
const acct = (o = {}) => ({ cash: 1000, equity: 1000, held: new Set(), eventCount: 0, eventExposure: 0, openExposure: 0, ...o });

test("decide: taker edge after fees, maker best-EV bid, sizing caps", () => {
  const ft = WEATHER_STRATEGIES.find((s) => s.id === "forecast-taker");
  const ctx = ctxWith({
    pFinal: [0.1, 0.6, 0.3],
    pMkt: [0.15, 0.45, 0.4],
    yesBooks: [{ bids: [[0.13, 100]], asks: [[0.16, 100]] }, { bids: [[0.43, 100]], asks: [[0.46, 300]] }, { bids: [[0.38, 100]], asks: [[0.41, 100]] }]
  });
  const d = decideEvent(ft, ctx, acct());
  assert.equal(d.ok, true);
  assert.equal(d.order.side, "YES");
  assert.equal(d.order.bucketIdx, 1);
  assert.ok(Math.abs(d.order.edge - (0.6 - 0.46 - 0.05 * 0.46 * 0.54)) < 1e-9);
  assert.ok(d.order.limitPrice >= 0.46 && d.order.limitPrice <= 0.6 - 0.06);
  assert.ok(d.order.stakeUsd <= 20 + 1e-9, "2% of bankroll cap");
  assert.equal(decideEvent(ft, ctx, acct({ eventExposure: 59.5 }), { caps: { maxEventPct: 0.06 } }).reason, "below_min_order_size");
  assert.equal(decideEvent(ft, ctx, acct({ openExposure: 700 }), { caps: { maxOpenPct: 0.6 } }).reason, "exposure_cap");
  assert.equal(decideEvent(ft, { ...ctx, leadBin: "d2" }, acct()).reason, "outside_window");

  const maker = WEATHER_STRATEGIES.find((s) => s.id === "maker-bidder");
  const dm = decideEvent(maker, ctx, acct(), { fillP: (dist) => (dist <= 0.011 ? 0.6 : dist <= 0.031 ? 0.3 : 0.05) });
  assert.equal(dm.order.execution, "maker");
  assert.ok(dm.order.price < 0.46 && dm.order.price >= 0.43, `posts just under the ask (${dm.order.price})`);

  const fav = WEATHER_STRATEGIES.find((s) => s.id === "market-favorite");
  const df = decideEvent(fav, ctx, acct());
  assert.equal(df.order.bucketIdx, 1);
  assert.equal(df.order.stakeUsd, 10);
});

// ---------------------------------------------------------------------------------------------- engine
test("engine: taker + maker fills, settlement, shadow learning, learning strategy gating", () => {
  const fills = [];
  const eng = createWeatherEngine({ bankrollUsd: 1000, learning: { enabled: true, minEvents: 3, lcbZ: 1 }, onFill: (f) => fills.push(f) });
  const now = Date.now();
  const mk = (eventId, yesBooks, pFinal, bookRx = now) => ({
    eventId, slug: `s${eventId}`, city: "NYC", kind: "high", date: "2026-10-05", key: `k${eventId}`, leadBin: "d1", hoursLeft: 30, tradeable: true,
    ...ctxWith({ pFinal, pMkt: [0.15, 0.45, 0.4], yesBooks, bookRx })
  });
  const books = [{ bids: [[0.13, 500]], asks: [[0.16, 500]] }, { bids: [[0.43, 500]], asks: [[0.46, 500]] }, { bids: [[0.38, 500]], asks: [[0.41, 500]] }];
  eng.onTick([mk("E1", books, [0.1, 0.6, 0.3])], now);
  let s = eng.summary();
  const ft = s.strategies.find((x) => x.id === "forecast-taker");
  assert.equal(ft.openPositions, 1);
  const mb = s.strategies.find((x) => x.id === "maker-bidder");
  assert.equal(mb.restingOrders, 1);
  assert.equal(s.strategies.find((x) => x.id === "learning").lastReason, "learning_no_proven_variant");
  assert.ok(fills.every((f) => f.city === "NYC"));

  // Ask trades through the maker's bid → fills at its price, no fee
  const order = s.orders.find((o) => o.strategyId === "maker-bidder");
  const crashed = books.map((b, i) => (i === Number(order.marketId.slice(1)) && order.side === "YES" ? { bids: [[order.price - 0.05, 500]], asks: [[order.price - 0.02, 500]] } : b));
  eng.onTick([mk("E1", crashed, [0.1, 0.6, 0.3])], now + 60_000);
  s = eng.summary();
  assert.equal(s.strategies.find((x) => x.id === "maker-bidder").makerFills, 1);

  // Bucket 1 wins
  const settled = eng.settleEvent({ eventId: "E1", winnerMarketId: "m1", city: "NYC", kind: "high", nowMs: now + 86_400_000 });
  const ftSettled = settled.find((x) => x.strategyId === "forecast-taker");
  assert.equal(ftSettled.won, true);
  assert.ok(Math.abs(ftSettled.pnl - (ftSettled.shares - ftSettled.cost)) < 1e-9);
  s = eng.summary();
  assert.equal(s.learning.settledEvents, 1);
  assert.ok(s.learning.variantsTested > 0, "shadow variants recorded");
  assert.ok(s.learning.windows.find((w) => w.window === "d1").n === 1);
  assert.equal(s.learning.cities.find((c) => c.key === "NYC|high").n, 1);

  // Seed a proven d1 variant → the learning strategy starts following it
  const v = eng.variants.find((x) => x.id === "v:final:e0.06:d1:YES:taker");
  for (let i = 0; i < 6; i += 1) eng.variantStats.record(v.id, 0.3 + (i % 2) * 0.02);
  eng.onTick([mk("E2", books, [0.1, 0.6, 0.3], now + 2 * 86_400_000)], now + 2 * 86_400_000);
  s = eng.summary();
  const learning = s.strategies.find((x) => x.id === "learning");
  assert.equal(learning.openPositions, 1, `learning reason: ${learning.lastReason}`);

  // Void → refund
  const before = s.strategies.find((x) => x.id === "forecast-taker").equity;
  eng.settleEvent({ eventId: "E2", winnerMarketId: null, city: "NYC", kind: "high", nowMs: now + 3 * 86_400_000 });
  assert.equal(eng.summary().strategies.find((x) => x.id === "forecast-taker").equity, before);

  // Round-trip persistence
  const eng2 = createWeatherEngine({ bankrollUsd: 1000 });
  assert.equal(eng2.restore(JSON.parse(JSON.stringify(eng.toJSON()))), true);
  assert.equal(eng2.summary().learning.settledEvents, 1);
  assert.equal(buildShadowVariants().length, 96);
});

// ---------------------------------------------------------------------------------------------- backfill
test("backfill: walk-forward learns each model's bias from history", () => {
  const station = { id: "KLGA", lat: 40.77, lon: -73.87, tz: NY };
  const dates = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const start = localDayBounds(dates[0], NY).startMs;
  const times = [];
  for (let h = 0; h < 31 * 24; h += 1) times.push(start + h * 3_600_000);
  const truth = (t) => 65 + 8 * Math.max(0, Math.sin(((((t - start) / 3_600_000) % 24) - 6) / 18 * Math.PI));
  const series = { warm: {}, cold: {} };
  for (const lead of [0, 1, 2, 3]) {
    series.warm[lead] = times.map((t) => truth(t) + 3.6); // +2°C
    series.cold[lead] = times.map((t) => truth(t) - 1.8); // −1°C
  }
  const realized = new Map(dates.map((d) => {
    const { startMs, endMs } = localDayBounds(d, NY);
    const xs = times.filter((t) => t >= startMs && t <= endMs).map(truth);
    return [d, { max: Math.max(...xs), min: Math.min(...xs) }];
  }));
  const skill = createSkillTracker();
  const used = learnFromHistory({ station, unit: "F", kinds: ["high"], prev: { times, series }, realized, skill });
  assert.equal(used, 30);
  assert.ok(Math.abs(skill.get("KLGA", "high", "model:warm", "d1").bias - 2) < 0.15);
  assert.ok(Math.abs(skill.get("KLGA", "high", "model:cold", "d1").bias + 1) < 0.15);
  assert.ok(Math.abs(skill.get("KLGA", "high", "blend", "d1").bias) < 0.5, "debiased blend lands near truth");
});

// ---------------------------------------------------------------------------------------------- end-to-end
test("end-to-end: discover → observe → forecast → trade → resolve → settle → learn (mocked network)", async () => {
  const day = "2026-10-05";
  const { startMs, endMs } = localDayBounds(day, NY);
  const now = startMs + 10 * 3_600_000; // 10:00 EDT
  const shape = diurnal(62, 70); // models peak at 70°F; observations run warmer
  const hours = [];
  for (let h = -24; h <= 72; h += 1) hours.push(startMs + h * 3_600_000);
  const val = (t, off = 0) => shape(((((t - startMs) / 3_600_000) % 24) + 24) % 24) + off;
  const books = {
    y100: { bids: [], asks: [{ price: "0.01", size: "500" }] },
    y101: { bids: [{ price: "0.02", size: "500" }], asks: [{ price: "0.04", size: "500" }] },
    y102: { bids: [{ price: "0.20", size: "500" }], asks: [{ price: "0.23", size: "500" }] },
    y103: { bids: [{ price: "0.45", size: "500" }], asks: [{ price: "0.48", size: "500" }] },
    y104: { bids: [{ price: "0.22", size: "500" }], asks: [{ price: "0.25", size: "500" }] },
    y105: { bids: [{ price: "0.04", size: "500" }], asks: [{ price: "0.06", size: "500" }] },
    y106: { bids: [], asks: [{ price: "0.01", size: "500" }] }
  };
  let resolved = false;
  let clock = now;
  const bid = (id) => books[`y${id}`].bids[0]?.price ?? null;
  const ask = (id) => books[`y${id}`].asks[0]?.price ?? null;
  const raw = () => nycEvent((i) => (resolved
    ? { closed: true, acceptingOrders: false, outcomePrices: i === 3 ? "[\"1\",\"0\"]" : "[\"0\",\"1\"]" }
    : { bestBid: bid(100 + i), bestAsk: ask(100 + i) }));
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const json = (d) => ({ ok: true, status: 200, json: async () => d, text: async () => (typeof d === "string" ? d : JSON.stringify(d)) });
    if (u.hostname.includes("gamma") && u.pathname === "/events") {
      if (u.searchParams.get("slug")) return json([raw()]);
      return json(!resolved && u.searchParams.get("offset") === "0" ? [raw()] : []);
    }
    if (u.pathname === "/api/data/stationinfo") return json([{ icaoId: "KLGA", lat: 40.7769, lon: -73.874, site: "LaGuardia" }]);
    if (u.pathname === "/api/data/metar") {
      const obs = [];
      for (let t = startMs - 6 * 3_600_000; t <= clock; t += 3_600_000) obs.push({ icaoId: "KLGA", obsTime: (t - 540_000) / 1000, temp: 0, rawOb: "" , _v: val(t, 1.5) });
      return json(obs.map((o) => {
        const c = (o._v - 32) * 5 / 9;
        const tenths = Math.round(Math.abs(c) * 10);
        return { icaoId: o.icaoId, obsTime: o.obsTime, temp: Math.round(c), rawOb: `KLGA RMK T${c < 0 ? 1 : 0}${String(tenths).padStart(3, "0")}0100` };
      }));
    }
    if (u.hostname.includes("open-meteo")) {
      if (u.searchParams.get("daily")) return json({ timezone: NY });
      if (u.hostname.startsWith("ensemble")) {
        const hourly = { time: hours.map((t) => t / 1000) };
        for (let j = 0; j < 8; j += 1) hourly[`temperature_2m_member${String(j + 1).padStart(2, "0")}_ecmwf_ifs025_ensemble`] = hours.map((t) => val(t, (j - 3.5) * 0.4));
        return json({ timezone: NY, hourly });
      }
      return json({ timezone: NY, hourly: { time: hours.map((t) => t / 1000), temperature_2m_ecmwf_ifs025: hours.map((t) => val(t)), temperature_2m_gfs_seamless: hours.map((t) => val(t, 0.6)) } });
    }
    if (u.pathname === "/books") return json(JSON.parse(opts.body).map(({ token_id }) => ({ asset_id: token_id, ...(books[token_id] ?? { bids: [], asks: [] }) })));
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };

  const { createWeatherSim } = await import("./runner.js");
  const cfg = { ...WCFG, logDir: TMP, models: ["ecmwf_ifs025", "gfs_seamless"], learning: { ...WCFG.learning, autoBackfill: false } };
  const sim = createWeatherSim({ cfg, log: () => {} });
  const built = await sim.tick(now);
  assert.equal(built.length, 1);
  const b = built[0];
  assert.equal(b.ctx.leadBin, "d0a");
  assert.equal(b.ctx.tradeable, true, `not tradeable: ${b.ctx.reason}`);
  assert.ok(b.obsInfo.ext > 65, "METAR tenths parsed into °F");
  assert.ok(Math.abs(b.probs.final.reduce((x, y) => x + y, 0) - 1) < 1e-9);
  assert.ok(b.fc.approaches.nowcast.err > 0.5, "observations warmer than models → nowcast pulls up");
  const summary = sim.engine.summary();
  assert.ok(summary.strategies.some((s) => s.openPositions + s.restingOrders > 0), "some strategy acted");
  assert.ok(fs.existsSync(path.join(TMP, "dashboard.json")));
  assert.ok(fs.existsSync(path.join(TMP, "trades.csv")));

  // Polymarket resolves 70-71°F; the event drops out of discovery and is settled by slug
  resolved = true;
  const later = endMs + 6 * 3_600_000;
  clock = later;
  await sim.tick(later);
  const after = sim.engine.summary();
  assert.equal(after.learning.settledEvents, 1);
  assert.equal(sim.calibrator.updates(), 1);
  assert.equal(after.strategies.reduce((a, s) => a + s.openPositions + s.restingOrders, 0), 0);
  assert.ok(sim.skill.get("KLGA", "high", "blend", "d0a").n >= 1, "observed high trained the skill tracker");
  sim.save();
  assert.ok(fs.existsSync(path.join(TMP, "state.json")));
  for (const f of ["settlements.csv", "outcomes.csv"]) assert.ok(fs.existsSync(path.join(TMP, f)), f);
});
