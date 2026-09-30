import { bestAsk, simulateTakerBuy } from "../core/orderbook.js";
import { roundTo } from "../core/math.js";
import { decideEntry } from "../strategy/decide.js";
import { createLearner } from "../strategy/learner.js";
import { createAdaptiveSelector } from "../strategy/adaptive.js";
import { buildShadowVariants, selectStrategies } from "../strategy/strategies.js";
import { createMarketState } from "./marketState.js";

/**
 * Paper-trading engine. Consumes three event types, in time order:
 *   { type: "cl",   ts, rx, price }                     Chainlink BTC/USD tick (settlement feed)
 *   { type: "snap", ts, round, binance, books }         1s market snapshot
 *   { type: "res",  ts, slug, outcome, ptb, final }     official Polymarket resolution
 *
 * Live mode and backtests feed the same events, so results are directly comparable.
 */
export function createSimEngine({
  config,
  strategyIds = config.sim.strategies,
  seed = 42,
  onTrade = null,
  onIntent = null
}) {
  const marketState = createMarketState({ feeds: config.feeds, rounds: config.rounds });
  const learner = createLearner(config.learner);
  const adaptive = createAdaptiveSelector({ seed });
  const shadowVariants = buildShadowVariants();
  const strategies = [...selectStrategies(strategyIds), ...shadowVariants];
  const variantById = new Map(shadowVariants.map((v) => [v.id, v]));

  const accounts = new Map();
  for (const s of strategies) accounts.set(s.id, newAccount(s, s.shadow ? 1e6 : config.sim.startingBankrollUsd));

  const learnerSamples = new Map(); // slug -> { slots: Set, samples: [] }
  const ptbCheck = { n: 0, sumAbsDiff: 0, maxAbsDiff: 0, mismatchedOutcomes: 0 };
  let lastCtx = null;
  let resolvedRounds = 0;
  let voidRounds = 0;

  function newAccount(strategy, bankroll) {
    return {
      strategy,
      cash: bankroll,
      start: bankroll,
      positions: [],
      pending: [], // taker orders waiting for latency
      resting: [], // maker orders on the book
      roundPos: new Map(),
      adaptiveChoice: new Map(),
      lastReason: null,
      reasonCounts: {},
      stats: { bets: 0, wins: 0, pnl: 0, fees: 0, staked: 0, expectedPnl: 0, brier: 0, voids: 0, peak: bankroll, maxDrawdown: 0 },
      equity: []
    };
  }

  function roundPosFor(acct, slug) {
    let rp = acct.roundPos.get(slug);
    if (!rp) {
      rp = { side: null, bets: 0, lastBetTs: null };
      acct.roundPos.set(slug, rp);
    }
    return rp;
  }

  function note(acct, reason) {
    acct.lastReason = reason;
    if (acct.strategy.shadow) return;
    acct.reasonCounts[reason] = (acct.reasonCounts[reason] ?? 0) + 1;
  }

  function openExposure(acct) {
    return acct.positions.reduce((a, p) => a + p.cost, 0)
      + acct.pending.reduce((a, o) => a + o.stakeUsd, 0)
      + acct.resting.reduce((a, o) => a + o.reservedUsd, 0);
  }

  function equityOf(acct) {
    return acct.cash + openExposure(acct);
  }

  function openPosition(acct, order, fill, ts) {
    acct.positions.push({
      slug: order.slug,
      side: order.side,
      shares: fill.shares,
      cost: fill.costUsd,
      fee: fill.feeUsd,
      avgPrice: fill.avgPrice,
      ts,
      decidedTs: order.decidedTs,
      secondsLeft: order.secondsLeft,
      pSide: order.pSide,
      pMarketSide: order.pMarketSide,
      edgePerShare: order.edgePerShare,
      execution: order.execution,
      variantId: order.variantId ?? null
    });
    acct.stats.fees += fill.feeUsd;
  }

  /** Undo the round bookkeeping of an order that never filled, so the strategy may try again. */
  function releaseBet(acct, order) {
    const slug = order.slug;
    const rp = roundPosFor(acct, slug);
    rp.bets = Math.max(0, rp.bets - 1);
    rp.lastBetTs = order.prevLastBetTs ?? null;
    const stillHolding = acct.positions.some((p) => p.slug === slug)
      || acct.pending.some((o) => o.slug === slug)
      || acct.resting.some((o) => o.slug === slug);
    if (!stillHolding) rp.side = null;
  }

  function processPending(acct, snap, ctx) {
    if (!acct.pending.length) return;
    const keep = [];
    for (const o of acct.pending) {
      if (snap.ts < o.fillAt) {
        keep.push(o);
        continue;
      }
      const booksFresh = snap.books && snap.ts - snap.books.rx <= config.feeds.maxBookAgeMs;
      const book = booksFresh ? (o.side === "UP" ? snap.books.up : snap.books.down) : null;
      const inRound = ctx.slug === o.slug && ctx.secondsLeft > 0;
      const fill = book && inRound
        ? simulateTakerBuy(book, { maxUsd: o.stakeUsd, limitPrice: o.limitPrice, feeSchedule: o.feeSchedule })
        : null;
      if (!fill) {
        acct.cash += o.stakeUsd;
        releaseBet(acct, o);
        note(acct, !book ? "fill_failed_stale_book" : "fill_failed_price_moved");
        continue;
      }
      acct.cash += o.stakeUsd - fill.costUsd;
      openPosition(acct, o, fill, snap.ts);
    }
    acct.pending = keep;
  }

  function cancelResting(acct, order) {
    acct.cash += order.reservedUsd;
    acct.resting = acct.resting.filter((o) => o !== order);
    releaseBet(acct, order);
  }

  function processResting(acct, snap, ctx) {
    for (const o of [...acct.resting]) {
      if (ctx.slug !== o.slug || !(ctx.secondsLeft > 0) || ctx.secondsLeft < acct.strategy.windowSec[0]) {
        cancelResting(acct, o);
        continue;
      }
      const booksFresh = snap.books && snap.ts - snap.books.rx <= config.feeds.maxBookAgeMs;
      if (!booksFresh) continue;
      const book = o.side === "UP" ? snap.books.up : snap.books.down;
      const ask = bestAsk(book);
      // Conservative fill rule: a seller must have traded *through* our price level when we joined an
      // existing queue, or reached it when we improved the bid. Queue position is otherwise unknown.
      const threshold = o.joinsQueue ? o.price - o.tickSize : o.price;
      if (ask === null || ask > threshold + 1e-9) continue;
      const available = book.asks.filter(([p]) => p <= o.price + 1e-9).reduce((a, [, s]) => a + s, 0);
      const shares = Math.min(o.shares, available);
      if (shares <= 1e-9) continue;
      const cost = roundTo(shares * o.price, 6);
      acct.cash += o.reservedUsd - cost;
      acct.resting = acct.resting.filter((x) => x !== o);
      openPosition(acct, o, { shares, costUsd: cost, feeUsd: 0, avgPrice: o.price }, snap.ts);
    }
  }

  function resolveStrategy(acct, ctx) {
    const s = acct.strategy;
    if (!s.adaptive) return s;
    if (!acct.adaptiveChoice.has(ctx.slug)) {
      const chosen = adaptive.choose(shadowVariants);
      acct.adaptiveChoice.set(ctx.slug, chosen?.id ?? null);
    }
    const id = acct.adaptiveChoice.get(ctx.slug);
    if (!id) return null;
    const v = variantById.get(id);
    return { ...v, id: s.id, shadow: false, variantId: v.id, sizing: s.sizing, maxBetsPerRound: s.maxBetsPerRound, execution: s.execution };
  }

  function decide(acct, ctx) {
    if (acct.cash < 1 && openExposure(acct) === 0) {
      note(acct, "busted");
      return;
    }
    const strategy = resolveStrategy(acct, ctx);
    if (!strategy) {
      note(acct, "no_proven_variant");
      return;
    }
    const rp = roundPosFor(acct, ctx.slug);
    const existingResting = acct.resting.find((o) => o.slug === ctx.slug);
    if (existingResting) {
      // Re-price: cancel, then decide afresh as if the order weren't there.
      cancelResting(acct, existingResting);
    }
    const d = decideEntry(strategy, ctx, acct, rp);
    if (!d.ok) {
      note(acct, d.reason);
      return;
    }
    note(acct, "entered");
    const prevLastBetTs = rp.lastBetTs;
    rp.side = d.side;
    rp.bets += 1;
    rp.lastBetTs = ctx.ts;
    acct.cash -= d.stakeUsd;
    const base = {
      slug: ctx.slug,
      side: d.side,
      decidedTs: ctx.ts,
      secondsLeft: ctx.secondsLeft,
      pSide: d.pSide,
      pMarketSide: d.pMarketSide,
      edgePerShare: d.edgePerShare,
      execution: d.execution,
      feeSchedule: ctx.feeSchedule,
      variantId: strategy.variantId ?? null,
      prevLastBetTs
    };
    if (d.execution === "maker") {
      acct.resting.push({
        ...base,
        price: d.limitPrice,
        tickSize: ctx.tickSize,
        joinsQueue: d.joinsQueue,
        shares: roundTo(d.stakeUsd / d.limitPrice, 6),
        reservedUsd: d.stakeUsd
      });
    } else {
      acct.pending.push({ ...base, stakeUsd: d.stakeUsd, limitPrice: d.limitPrice, fillAt: ctx.ts + config.sim.latencyMs });
    }
    if (onIntent && !acct.strategy.shadow) {
      onIntent({ strategyId: acct.strategy.id, intent: d, ctx });
    }
  }

  function sampleForLearner(ctx) {
    if (!ctx.features || ctx.secondsLeft > config.learner.sampleWindowSec) return;
    const slot = Math.floor(ctx.secondsLeft / config.learner.sampleEverySec);
    let bucket = learnerSamples.get(ctx.slug);
    if (!bucket) {
      bucket = { slots: new Set(), samples: [] };
      learnerSamples.set(ctx.slug, bucket);
    }
    if (bucket.slots.has(slot)) return;
    bucket.slots.add(slot);
    bucket.samples.push({ x: ctx.features, pFair: ctx.probs.fair, pMarket: ctx.probs.market });
  }

  function onSnapshot(snap) {
    const ctx = marketState.buildContext(snap, learner);
    lastCtx = ctx;
    for (const acct of accounts.values()) {
      processPending(acct, snap, ctx);
      processResting(acct, snap, ctx);
    }
    if (!ctx.tradeable) {
      for (const acct of accounts.values()) note(acct, ctx.notTradeableReason);
      return ctx;
    }
    sampleForLearner(ctx);
    for (const acct of accounts.values()) decide(acct, ctx);
    return ctx;
  }

  function settleAccount(acct, slug, outcome, ts) {
    for (const o of acct.pending.filter((x) => x.slug === slug)) acct.cash += o.stakeUsd;
    acct.pending = acct.pending.filter((x) => x.slug !== slug);
    for (const o of acct.resting.filter((x) => x.slug === slug)) acct.cash += o.reservedUsd;
    acct.resting = acct.resting.filter((x) => x.slug !== slug);

    const mine = acct.positions.filter((p) => p.slug === slug);
    acct.positions = acct.positions.filter((p) => p.slug !== slug);
    acct.roundPos.delete(slug);
    acct.adaptiveChoice.delete(slug);
    if (!mine.length) return;

    const s = acct.stats;
    for (const p of mine) {
      if (outcome === null) {
        // Void: the round never got an official outcome; refund as if the bet was never made.
        acct.cash += p.cost;
        s.fees -= p.fee;
        s.voids += 1;
        continue;
      }
      const won = p.side === outcome;
      const payout = won ? p.shares : 0;
      const pnl = payout - p.cost;
      acct.cash += payout;
      s.bets += 1;
      s.wins += won ? 1 : 0;
      s.pnl += pnl;
      s.staked += p.cost;
      s.expectedPnl += p.edgePerShare * p.shares;
      s.brier += (p.pSide - (won ? 1 : 0)) ** 2;
      if (acct.strategy.shadow) adaptive.record(acct.strategy.id, pnl / p.cost);
      if (onTrade && !acct.strategy.shadow) {
        onTrade({ ...p, strategyId: acct.strategy.id, outcome, won, payout, pnl, settledTs: ts, cashAfter: acct.cash });
      }
    }
    const eq = equityOf(acct);
    s.peak = Math.max(s.peak, eq);
    s.maxDrawdown = Math.max(s.maxDrawdown, s.peak > 0 ? (s.peak - eq) / s.peak : 0);
    if (!acct.strategy.shadow) {
      acct.equity.push([ts, roundTo(eq, 4)]);
      if (acct.equity.length > 5000) acct.equity.splice(0, acct.equity.length - 5000);
    }
  }

  function onResolution({ ts, slug, outcome, ptb = null, final = null }) {
    const round = marketState.getRound(slug);
    if (outcome === "UP" || outcome === "DOWN") {
      resolvedRounds += 1;
      if (round?.ptb && ptb) {
        const diff = Math.abs(round.ptb - ptb);
        ptbCheck.n += 1;
        ptbCheck.sumAbsDiff += diff;
        ptbCheck.maxAbsDiff = Math.max(ptbCheck.maxAbsDiff, diff);
        // Would the ticks we latched have called the round differently from Polymarket?
        if (round.endPrice) {
          const localOutcome = round.endPrice >= round.ptb ? "UP" : "DOWN";
          if (localOutcome !== outcome) ptbCheck.mismatchedOutcomes += 1;
        }
      }
      marketState.recordSettlement(slug, ptb, final);
      const bucket = learnerSamples.get(slug);
      if (bucket) {
        learner.learnRound(bucket.samples, outcome === "UP" ? 1 : 0);
      }
    } else {
      voidRounds += 1;
    }
    learnerSamples.delete(slug);
    const o = outcome === "UP" || outcome === "DOWN" ? outcome : null;
    for (const acct of accounts.values()) settleAccount(acct, slug, o, ts);
    marketState.forgetRound(slug);
  }

  function handle(event) {
    if (event.type === "cl") marketState.onChainlinkTick(event);
    else if (event.type === "snap") return onSnapshot(event);
    else if (event.type === "res") onResolution(event);
    return null;
  }

  function openSlugs() {
    const slugs = new Set();
    for (const acct of accounts.values()) for (const p of acct.positions) slugs.add(p.slug);
    for (const slug of learnerSamples.keys()) slugs.add(slug);
    return [...slugs];
  }

  function accountSummary(acct) {
    const s = acct.stats;
    const eq = equityOf(acct);
    const topReasons = Object.entries(acct.reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return {
      id: acct.strategy.id,
      label: acct.strategy.label,
      risk: acct.strategy.risk,
      description: acct.strategy.description,
      start: acct.start,
      cash: roundTo(acct.cash, 4),
      equity: roundTo(eq, 4),
      roi: acct.start > 0 ? (eq - acct.start) / acct.start : null,
      bets: s.bets,
      wins: s.wins,
      winRate: s.bets ? s.wins / s.bets : null,
      pnl: roundTo(s.pnl, 4),
      fees: roundTo(s.fees, 4),
      staked: roundTo(s.staked, 4),
      returnOnStaked: s.staked > 0 ? s.pnl / s.staked : null,
      expectedPnl: roundTo(s.expectedPnl, 4),
      brier: s.bets ? s.brier / s.bets : null,
      maxDrawdown: s.maxDrawdown,
      voids: s.voids,
      open: acct.positions.length + acct.pending.length + acct.resting.length,
      busted: acct.cash < 1 && openExposure(acct) === 0,
      lastReason: acct.lastReason,
      topReasons,
      currentVariant: acct.strategy.adaptive && lastCtx?.slug ? acct.adaptiveChoice.get(lastCtx.slug) ?? null : undefined,
      equityCurve: acct.equity
    };
  }

  function summary({ includeCurves = false } = {}) {
    const visible = [...accounts.values()].filter((a) => !a.strategy.shadow).map(accountSummary);
    if (!includeCurves) for (const v of visible) delete v.equityCurve;
    return {
      strategies: visible.sort((a, b) => a.risk - b.risk),
      learner: { updates: learner.updates(), weights: learner.weights(), scorecard: learner.scorecard(), calibration: learner.calibration() },
      adaptive: adaptive.leaderboard(shadowVariants),
      ptbCheck: { ...ptbCheck, meanAbsDiff: ptbCheck.n ? ptbCheck.sumAbsDiff / ptbCheck.n : null },
      settlementNoise: marketState.settleStats(),
      resolvedRounds,
      voidRounds
    };
  }

  function toJSON() {
    return {
      version: 1,
      savedAt: lastCtx?.ts ?? null,
      accounts: [...accounts.values()].map((a) => ({
        id: a.strategy.id,
        cash: a.cash + a.pending.reduce((x, o) => x + o.stakeUsd, 0) + a.resting.reduce((x, o) => x + o.reservedUsd, 0),
        start: a.start,
        positions: a.positions,
        stats: a.stats,
        reasonCounts: a.reasonCounts,
        equity: a.equity
      })),
      learner: learner.toJSON(),
      adaptive: adaptive.toJSON(),
      marketState: marketState.toJSON(),
      learnerSamples: Object.fromEntries([...learnerSamples].map(([k, v]) => [k, { slots: [...v.slots], samples: v.samples }])),
      ptbCheck,
      resolvedRounds,
      voidRounds
    };
  }

  function restore(state) {
    if (!state || state.version !== 1) return false;
    for (const saved of state.accounts ?? []) {
      const acct = accounts.get(saved.id);
      if (!acct) continue;
      acct.cash = Number(saved.cash);
      acct.start = Number(saved.start);
      acct.positions = Array.isArray(saved.positions) ? saved.positions : [];
      acct.stats = { ...acct.stats, ...saved.stats };
      acct.reasonCounts = saved.reasonCounts ?? {};
      acct.equity = Array.isArray(saved.equity) ? saved.equity : [];
      for (const p of acct.positions) {
        const rp = roundPosFor(acct, p.slug);
        rp.side = p.side;
        rp.bets += 1;
        rp.lastBetTs = p.decidedTs ?? p.ts;
      }
    }
    learner.restore(state.learner);
    adaptive.restore(state.adaptive);
    marketState.restore(state.marketState);
    for (const [slug, v] of Object.entries(state.learnerSamples ?? {})) {
      learnerSamples.set(slug, { slots: new Set(v.slots), samples: v.samples });
    }
    Object.assign(ptbCheck, state.ptbCheck ?? {});
    resolvedRounds = Number(state.resolvedRounds) || 0;
    voidRounds = Number(state.voidRounds) || 0;
    return true;
  }

  function resetAccounts() {
    for (const [id, acct] of accounts) accounts.set(id, newAccount(acct.strategy, acct.strategy.shadow ? 1e6 : config.sim.startingBankrollUsd));
  }

  return {
    handle,
    summary,
    toJSON,
    restore,
    resetAccounts,
    openSlugs,
    lastContext: () => lastCtx,
    learner,
    marketState,
    strategyIds: () => [...accounts.values()].filter((a) => !a.strategy.shadow).map((a) => a.strategy.id),
    accountStats: (id) => {
      const a = accounts.get(id);
      return a ? accountSummary(a) : null;
    }
  };
}
