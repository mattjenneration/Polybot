import { mulberry32 } from "../strategy/adaptive.js";
import { fairProbUp } from "../core/fairValue.js";
import { clamp, logit, sigmoid } from "../core/math.js";
import { DEFAULT_FEE_SCHEDULE } from "../core/fees.js";

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function level(p, tick) {
  return Math.round(clamp(p, tick, 1 - tick) / tick) * tick;
}

function bookAround(p, halfSpread, tick, size) {
  const bid = level(p - halfSpread, tick);
  let ask = level(p + halfSpread, tick);
  if (ask <= bid) ask = Math.min(1 - tick, bid + tick);
  const bids = [];
  const asks = [];
  for (let i = 0; i < 5; i += 1) {
    const b = +(bid - i * tick).toFixed(4);
    const a = +(ask + i * tick).toFixed(4);
    if (b > 0) bids.push([b, size]);
    if (a < 1) asks.push([a, size]);
  }
  return { bids, asks };
}

/**
 * Synthetic 5-minute rounds for tests and demos.
 *   marketNoise  stdev of the market's logit error vs true fair value (0 = efficient market)
 *   leadSec      how many seconds Binance leads Chainlink
 *   settleNoise  log-stdev of Polymarket's official start/final prices around the observed ticks
 */
export function generateSyntheticEvents({
  rounds = 50,
  seed = 7,
  startMs = Date.UTC(2026, 0, 1),
  sigma = 1.2e-4,
  marketNoise = 0,
  halfSpread = 0.01,
  leadSec = 2,
  settleNoise = 0,
  roundSeconds = 300
} = {}) {
  const rng = mulberry32(seed);
  const tick = 0.01;
  const totalSec = rounds * roundSeconds + 120;
  const prices = [60_000];
  for (let i = 1; i <= totalSec + leadSec; i += 1) prices.push(prices[i - 1] * Math.exp(sigma * gaussian(rng)));

  const events = [];
  const resolutions = new Map();
  // Warm-up minute before the first round so volatility estimates exist.
  const t0 = startMs - 60_000;
  let roundNoise = 0;
  for (let s = 0; s <= totalSec; s += 1) {
    const ts = t0 + s * 1000;
    const clPrice = prices[s];
    events.push({ type: "cl", ts, rx: ts, price: clPrice });

    const elapsed = ts - startMs;
    if (elapsed < 0) continue;
    const idx = Math.floor(elapsed / (roundSeconds * 1000));
    if (idx >= rounds) continue;
    const rStart = startMs + idx * roundSeconds * 1000;
    const rEnd = rStart + roundSeconds * 1000;
    const slug = `btc-updown-5m-${rStart / 1000}`;
    const ptb = prices[(rStart - t0) / 1000];
    if (ts === rStart) {
      roundNoise = marketNoise * gaussian(rng);
      const officialPtb = ptb * Math.exp(settleNoise * gaussian(rng));
      const officialFinal = prices[(rEnd - t0) / 1000] * Math.exp(settleNoise * gaussian(rng));
      resolutions.set(slug, { outcome: officialFinal >= officialPtb ? "UP" : "DOWN", ptb: officialPtb, final: officialFinal });
    }
    const secondsLeft = (rEnd - ts) / 1000;
    const pTrue = fairProbUp({ price: clPrice, priceToBeat: ptb, secondsLeft, sigma, settleVar: 2 * settleNoise ** 2 });
    const pMkt = clamp(sigmoid(logit(pTrue) + roundNoise + (marketNoise / 3) * gaussian(rng)), 0.01, 0.99);
    events.push({
      type: "snap",
      ts,
      round: { slug, startMs: rStart, endMs: rEnd, feeSchedule: { ...DEFAULT_FEE_SCHEDULE }, minOrderSize: 5, tickSize: tick },
      binance: { ts, price: prices[s + leadSec] * 1.0002 },
      books: { rx: ts, up: bookAround(pMkt, halfSpread, tick, 500), down: bookAround(1 - pMkt, halfSpread, tick, 500) }
    });
  }
  return { events, resolutions };
}

/** Run synthetic events through an engine, injecting outcomes 60s after each round. */
export function replaySynthetic(engine, { events, resolutions }) {
  const due = [];
  const seen = new Set();
  for (const e of events) {
    const clock = e.type === "cl" ? e.rx : e.ts;
    while (due.length && due[0].at <= clock) {
      const d = due.shift();
      engine.handle({ type: "res", ts: d.at, slug: d.slug, ...resolutions.get(d.slug) });
    }
    if (e.type === "snap" && !seen.has(e.round.slug)) {
      seen.add(e.round.slug);
      due.push({ slug: e.round.slug, at: e.round.endMs + 60_000 });
    }
    engine.handle(e);
  }
  for (const d of due) engine.handle({ type: "res", ts: d.at, slug: d.slug, ...resolutions.get(d.slug) });
  return engine.summary();
}
