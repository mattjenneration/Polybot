import { fairProbUp } from "../core/fairValue.js";
import { createVolEstimator } from "../core/volatility.js";
import { depthShares, midPrice } from "../core/orderbook.js";
import { buildFeatures } from "../strategy/learner.js";

/**
 * Everything derived from raw feed events that decisions depend on:
 * Chainlink tick history, volatility, Binance–Chainlink basis, and per-round price-to-beat.
 *
 * Time comes only from the events themselves, so live runs and replays behave identically.
 */
// Prior for the per-endpoint gap between observed ticks and Polymarket's settlement prices,
// as a log-return stdev (~2.5 bp ≈ $20 at $80k), measured on live rounds in Sep 2026.
export const SETTLE_NOISE_PRIOR = 2.5e-4;
const SETTLE_PRIOR_WEIGHT = 5;

export function createMarketState({ feeds, rounds: roundCfg }) {
  const clTicks = []; // { ts (source), rx (received), price }, ascending by ts
  const clVol = createVolEstimator();
  const bnVol = createVolEstimator();
  const rounds = new Map(); // slug -> round state
  const settle = { variance: SETTLE_NOISE_PRIOR ** 2, n: 0, meanError: 0 };
  let basisEwma = null;
  let basisTs = null;
  let lastBinance = null;

  /** First tick stamped in [atMs, atMs + tolerance]; "missed" if the feed skipped that window. */
  function tickAt(atMs) {
    const deadline = atMs + roundCfg.ptbLatchToleranceMs;
    for (const t of clTicks) {
      if (t.ts < atMs) continue;
      if (t.ts > deadline) break;
      return t;
    }
    const last = clTicks[clTicks.length - 1];
    return last && last.ts > deadline ? "missed" : null;
  }

  function tryLatch(round) {
    if (round.ptb === null && !round.ptbMissed) {
      const t = tickAt(round.startMs);
      if (t === "missed") round.ptbMissed = true;
      else if (t) {
        round.ptb = t.price;
        round.ptbTs = t.ts;
      }
    }
    if (round.endPrice === null && !round.endMissed) {
      const t = tickAt(round.endMs);
      if (t === "missed") round.endMissed = true;
      else if (t) round.endPrice = t.price;
    }
  }

  function onChainlinkTick({ ts, rx, price }) {
    if (!(price > 0) || !Number.isFinite(ts)) return;
    const last = clTicks[clTicks.length - 1];
    if (last && ts <= last.ts) return; // duplicate / out-of-order
    clTicks.push({ ts, rx: rx ?? ts, price });
    const cutoff = ts - 15 * 60_000;
    while (clTicks.length && clTicks[0].ts < cutoff) clTicks.shift();
    clVol.observe(ts, price);
    for (const r of rounds.values()) tryLatch(r);
  }

  function registerRound(info) {
    if (!info?.slug) return null;
    let r = rounds.get(info.slug);
    if (!r) {
      r = { ...info, ptb: null, ptbTs: null, ptbMissed: false, endPrice: null, endMissed: false };
      rounds.set(info.slug, r);
      tryLatch(r);
    }
    return r;
  }

  function addSettleError(e) {
    if (!Number.isFinite(e)) return;
    settle.n += 1;
    const alpha = Math.max(1 / (settle.n + SETTLE_PRIOR_WEIGHT), 0.02);
    settle.variance += alpha * (e * e - settle.variance);
    settle.meanError += alpha * (e - settle.meanError);
  }

  /** Learn how far Polymarket's official start/final prices sit from the ticks we latched. */
  function recordSettlement(slug, officialPtb, officialFinal) {
    const r = rounds.get(slug);
    if (!r) return null;
    const out = { ptbError: null, finalError: null };
    if (r.ptb && officialPtb > 0) {
      out.ptbError = Math.log(officialPtb / r.ptb);
      addSettleError(out.ptbError);
    }
    if (r.endPrice && officialFinal > 0) {
      out.finalError = Math.log(officialFinal / r.endPrice);
      addSettleError(out.finalError);
    }
    return out;
  }

  /** Total extra log-variance from not knowing either official endpoint exactly. */
  function settleVar() {
    return 2 * settle.variance;
  }

  function getRound(slug) {
    return rounds.get(slug) ?? null;
  }

  function forgetRound(slug) {
    rounds.delete(slug);
  }

  function latestChainlink() {
    return clTicks.length ? clTicks[clTicks.length - 1] : null;
  }

  function onBinance({ ts, price }) {
    if (!(price > 0) || !Number.isFinite(ts)) return;
    if (lastBinance && ts <= lastBinance.ts) return;
    lastBinance = { ts, price };
    bnVol.observe(ts, price);
  }

  /**
   * @param {object} snap   { ts, round, binance, books: { rx, up, down } }
   * @param {object} learner
   */
  function buildContext(snap, learner) {
    const ts = snap.ts;
    if (snap.binance) onBinance(snap.binance);
    const round = snap.round ? registerRound(snap.round) : null;

    const ctx = {
      ts,
      slug: round?.slug ?? null,
      secondsLeft: round ? (round.endMs - ts) / 1000 : null,
      roundSeconds: round ? (round.endMs - round.startMs) / 1000 : null,
      ptb: round?.ptb ?? null,
      price: null,
      sigma: null,
      leadZ: null,
      imbalance: null,
      settleVar: null,
      probs: { fair: null, market: null, learned: null },
      features: null,
      books: { UP: snap.books?.up ?? null, DOWN: snap.books?.down ?? null },
      feeSchedule: round?.feeSchedule,
      minOrderSize: round?.minOrderSize ?? 5,
      tickSize: round?.tickSize ?? 0.01,
      tradeable: false,
      notTradeableReason: null
    };

    const fail = (reason) => {
      ctx.notTradeableReason = reason;
      return ctx;
    };

    if (!round) return fail("no_round");

    // Market-implied probability from both books.
    const upMid = midPrice(ctx.books.UP);
    const downMid = midPrice(ctx.books.DOWN);
    if (upMid !== null && downMid !== null) ctx.probs.market = (upMid + (1 - downMid)) / 2;
    else if (upMid !== null) ctx.probs.market = upMid;
    else if (downMid !== null) ctx.probs.market = 1 - downMid;

    const upBidDepth = depthShares(ctx.books.UP?.bids);
    const downBidDepth = depthShares(ctx.books.DOWN?.bids);
    if (upBidDepth + downBidDepth > 0) ctx.imbalance = (upBidDepth - downBidDepth) / (upBidDepth + downBidDepth);

    const cl = latestChainlink();
    const clFresh = cl && ts - cl.rx <= feeds.maxChainlinkAgeMs;
    if (cl) ctx.price = cl.price;

    const sigma = clVol.isWarm() ? clVol.sigma() : bnVol.isWarm() ? bnVol.sigma() : null;
    ctx.sigma = sigma;

    const bnFresh = lastBinance && ts - lastBinance.ts <= feeds.maxBinanceAgeMs;
    if (clFresh && bnFresh) {
      const basis = Math.log(lastBinance.price / cl.price);
      if (basisEwma === null) basisEwma = basis;
      else {
        const dt = Math.max(0, (ts - basisTs) / 1000);
        const alpha = 1 - Math.exp((-Math.LN2 * dt) / 120);
        basisEwma += alpha * (basis - basisEwma);
      }
      basisTs = ts;
      if (sigma && ctx.secondsLeft > 0) {
        ctx.leadZ = (basis - basisEwma) / Math.sqrt(sigma * sigma * ctx.secondsLeft + settleVar());
      }
    }

    if (ctx.secondsLeft <= 0) return fail("round_over");
    if (ts < round.startMs) return fail("round_not_started");
    if (!cl) return fail("no_chainlink");
    if (!clFresh) return fail("chainlink_stale");
    if (ctx.ptb === null) return fail(round.ptbMissed ? "missed_round_start" : "awaiting_price_to_beat");
    if (!sigma) return fail("vol_warming_up");
    if (!snap.books || ts - snap.books.rx > feeds.maxBookAgeMs) return fail("book_stale");
    if (ctx.probs.market === null) return fail("empty_book");

    ctx.settleVar = settleVar();
    ctx.probs.fair = fairProbUp({ price: ctx.price, priceToBeat: ctx.ptb, secondsLeft: ctx.secondsLeft, sigma, settleVar: ctx.settleVar });
    ctx.features = buildFeatures({
      pFair: ctx.probs.fair,
      pMarket: ctx.probs.market,
      leadZ: ctx.leadZ,
      imbalance: ctx.imbalance,
      secondsLeft: ctx.secondsLeft,
      roundSeconds: ctx.roundSeconds
    });
    ctx.probs.learned = learner ? learner.predict(ctx.features) : null;
    ctx.tradeable = true;
    return ctx;
  }

  return {
    onChainlinkTick,
    registerRound,
    getRound,
    forgetRound,
    latestChainlink,
    buildContext,
    recordSettlement,
    settleStats: () => ({ n: settle.n, stdev: Math.sqrt(settle.variance), meanError: settle.meanError }),
    rounds: () => [...rounds.values()],
    toJSON() {
      return { clVol: clVol.toJSON(), bnVol: bnVol.toJSON(), settle };
    },
    restore(state) {
      clVol.restore(state?.clVol);
      bnVol.restore(state?.bnVol);
      if (state?.settle && Number.isFinite(state.settle.variance) && state.settle.variance > 0) Object.assign(settle, state.settle);
    }
  };
}
