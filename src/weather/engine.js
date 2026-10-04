/**
 * Weather paper-trading engine (pure: no network). Each tick takes event contexts (books + probabilities) and:
 *  - fills or expires resting maker bids (fill only when the ask trades through our price; see processOrders)
 *  - asks every strategy account for an entry per tradeable event (taker fills walk the real book with fees)
 * settleEvent() pays out an event from the official Polymarket resolution and feeds learning mode:
 * per-variant, per-city and per-timing-window returns (one sample per event), and maker fill outcomes.
 */
import { simulateTakerBuy } from "../core/orderbook.js";
import { roundTo } from "../core/math.js";
import { decideEvent } from "./strategy/decide.js";
import { buildShadowVariants, selectStrategies, TIMING_WINDOWS } from "./strategy/strategies.js";
import { cityPolicy, createFillModel, createReturnStats, createVariantChooser } from "./strategy/learning.js";

const windowOf = (bin) => Object.entries(TIMING_WINDOWS).find(([, bins]) => bins.includes(bin))?.[0] ?? bin;

export function createWeatherEngine({
  strategyIds = ["all"],
  bankrollUsd = 1000,
  shadowStakeUsd = 1,
  caps = { maxEventPct: 0.06, maxOpenPct: 0.6 },
  learning = { enabled: true, minEvents: 15, lcbZ: 1 },
  takerMaxBookAgeMs = 120_000,
  seed = 7,
  onFill = null,
  onSettle = null
} = {}) {
  const variants = buildShadowVariants(shadowStakeUsd);
  const visible = selectStrategies(strategyIds);
  const variantStats = createReturnStats({ decay: 0.995 });
  const cityStats = createReturnStats({ decay: 0.99 });
  const windowStats = createReturnStats({ decay: 0.995 });
  const fillModel = createFillModel();
  const chooseVariant = createVariantChooser({ seed });
  const accounts = new Map();
  for (const s of [...visible, ...variants]) accounts.set(s.id, newAccount(s));
  let settledEvents = 0;
  let voidEvents = 0;
  // Identical bids from different variants are one experiment: count each (market, side, price) once.
  const fillSeen = new Map(); // key → eventId

  function recordFill(o, filled) {
    if (!learning.enabled) return;
    const key = `${o.marketId}|${o.side}|${o.price}`;
    if (fillSeen.has(key)) return;
    fillSeen.set(key, o.eventId);
    fillModel.record(o.dist, o.leadBin, filled);
  }

  function newAccount(strategy) {
    const start = strategy.shadow ? 1e6 : bankrollUsd;
    return {
      strategy,
      cash: start,
      start,
      positions: [],
      orders: [],
      choices: {},
      reasons: {},
      lastReason: null,
      stats: { bets: 0, wins: 0, events: 0, pnl: 0, fees: 0, staked: 0, expectedPnl: 0, brier: 0, voids: 0, peak: start, maxDrawdown: 0, makerOrders: 0, makerFills: 0 },
      equity: []
    };
  }

  const exposure = (acct, eventId = null) =>
    acct.positions.reduce((a, p) => a + (eventId === null || p.eventId === eventId ? p.cost : 0), 0)
    + acct.orders.reduce((a, o) => a + (eventId === null || o.eventId === eventId ? o.reservedUsd : 0), 0);
  const equityOf = (acct) => acct.cash + exposure(acct);

  function note(acct, reason) {
    acct.lastReason = reason;
    if (!acct.strategy.shadow) acct.reasons[reason] = (acct.reasons[reason] ?? 0) + 1;
  }

  function openPosition(acct, o, fill, ctx, nowMs) {
    const pos = {
      eventId: ctx.eventId, marketId: o.marketId, side: o.side, shares: fill.shares, cost: fill.costUsd, fee: fill.feeUsd,
      leadBin: o.leadBin ?? ctx.leadBin, variantId: o.variantId ?? null
    };
    if (!acct.strategy.shadow) {
      Object.assign(pos, {
        label: ctx.buckets[o.bucketIdx]?.label ?? "", city: ctx.city, kind: ctx.kind, date: ctx.date, slug: ctx.slug,
        avgPrice: fill.avgPrice, pSide: o.pSide, pMarketSide: o.pMarketSide, edge: o.edge, execution: o.execution, openedAt: nowMs
      });
      acct.stats.fees += fill.feeUsd;
      onFill?.({ strategyId: acct.strategy.id, ...pos });
    }
    acct.positions.push(pos);
  }

  /** Resting bids: fill when the ask trades through (or reaches a price we alone improved to); else expire. */
  function processOrders(acct, ctxById, nowMs) {
    if (!acct.orders.length) return;
    const keep = [];
    for (const o of acct.orders) {
      const ctx = ctxById.get(o.eventId);
      const b = ctx?.buckets[o.bucketIdx];
      const book = b ? (o.side === "YES" ? b.yes : b.no) : null;
      const expired = nowMs >= o.expiresAt || !ctx || !ctx.tradeable || !o.windows.includes(ctx.leadBin);
      const p = ctx?.probs?.[o.probSource];
      const pSide = p ? (o.side === "YES" ? p[o.bucketIdx] : 1 - p[o.bucketIdx]) : null;
      if (book && !expired) {
        const ask = book.asks[0]?.[0] ?? null;
        const threshold = o.joinsQueue ? o.price - o.tick : o.price;
        if (ask !== null && ask <= threshold + 1e-9) {
          const available = book.asks.filter(([px]) => px <= o.price + 1e-9).reduce((a, [, s]) => a + s, 0);
          const shares = Math.min(o.shares, available);
          if (shares > 1e-9) {
            const cost = roundTo(shares * o.price, 6);
            acct.cash += o.reservedUsd - cost;
            openPosition(acct, o, { shares, costUsd: cost, feeUsd: 0, avgPrice: o.price }, ctx, nowMs);
            recordFill(o, true);
            if (!acct.strategy.shadow) acct.stats.makerFills += 1;
            continue;
          }
        }
        // The edge is gone (model moved against us): pull the bid
        if (pSide !== null && pSide - o.price < 0) {
          acct.cash += o.reservedUsd;
          continue;
        }
        keep.push(o);
        continue;
      }
      if (expired) {
        acct.cash += o.reservedUsd;
        if (ctx) recordFill(o, false);
        continue;
      }
      keep.push(o); // no fresh book this tick; check again next tick
    }
    acct.orders = keep;
  }

  /** The learning strategy's rules for this event × lead bin: the variant Thompson sampling picks (sticky). */
  function resolveStrategy(acct, ctx) {
    const s = acct.strategy;
    if (!s.adaptive) return { strategy: s, sizeMult: 1 };
    const key = `${ctx.eventId}|${ctx.leadBin}`;
    if (!(key in acct.choices)) {
      const pick = chooseVariant(variants, variantStats, {
        minEvents: learning.minEvents, lcbZ: learning.lcbZ, filter: (v) => v.windows.includes(ctx.leadBin)
      });
      acct.choices[key] = pick ? { id: pick.variant.id, pPositive: pick.summary.pPositive } : null;
    }
    const choice = acct.choices[key];
    if (!choice) return { strategy: null, reason: "learning_no_proven_variant" };
    const v = variants.find((x) => x.id === choice.id);
    const city = cityPolicy(cityStats.summary(`${ctx.city}|${ctx.kind}`, { lcbZ: learning.lcbZ }), learning);
    if (city.mult <= 0) return { strategy: null, reason: "learning_city_avoided" };
    const confidence = Math.max(0, Math.min(1, (choice.pPositive - 0.5) * 2));
    return {
      strategy: { ...v, id: s.id, shadow: false, variantId: v.id, sizing: s.sizing, maxPerEvent: s.maxPerEvent, makerTtlMin: s.makerTtlMin },
      sizeMult: confidence * city.mult
    };
  }

  function decide(acct, ctx, nowMs) {
    if (acct.cash < 1 && exposure(acct) === 0) return note(acct, "busted");
    const r = resolveStrategy(acct, ctx);
    if (!r.strategy) return note(acct, r.reason);
    const strategy = r.strategy;
    const held = new Set();
    let eventCount = 0;
    for (const p of acct.positions) if (p.eventId === ctx.eventId) { held.add(p.marketId); eventCount += 1; }
    for (const o of acct.orders) if (o.eventId === ctx.eventId) { held.add(o.marketId); eventCount += 1; }
    const d = decideEvent(strategy, ctx, {
      cash: acct.cash, equity: equityOf(acct), held, eventCount, eventExposure: exposure(acct, ctx.eventId), openExposure: exposure(acct)
    }, { fillP: (dist, bin) => fillModel.p(dist, bin), sizeMult: r.sizeMult, caps: acct.strategy.shadow ? {} : caps });
    if (!d.ok) return note(acct, d.reason);
    const o = { ...d.order, leadBin: ctx.leadBin, variantId: strategy.variantId ?? (acct.strategy.shadow ? acct.strategy.id : null) };
    const b = ctx.buckets[o.bucketIdx];

    if (o.execution === "maker") {
      acct.cash -= o.stakeUsd;
      acct.orders.push({
        eventId: ctx.eventId, marketId: o.marketId, bucketIdx: o.bucketIdx, side: o.side, price: o.price, tick: b.tick,
        shares: roundTo(o.stakeUsd / o.price, 6), reservedUsd: o.stakeUsd, placedAt: nowMs,
        expiresAt: nowMs + (strategy.makerTtlMin ?? 120) * 60_000, joinsQueue: o.joinsQueue, dist: o.dist,
        pSide: o.pSide, pMarketSide: o.pMarketSide, edge: o.edge, execution: "maker", leadBin: ctx.leadBin,
        variantId: o.variantId, windows: strategy.windows, probSource: strategy.probSource
      });
      if (!acct.strategy.shadow) acct.stats.makerOrders += 1;
      return note(acct, "bid_posted");
    }

    const book = o.side === "YES" ? b.yes : b.no;
    if (!book || nowMs - (b.bookRx ?? 0) > takerMaxBookAgeMs) return note(acct, "stale_book");
    const fill = simulateTakerBuy(book, { maxUsd: o.stakeUsd, limitPrice: o.limitPrice, feeSchedule: b.feeSchedule });
    if (!fill) return note(acct, "no_fill");
    acct.cash -= fill.costUsd;
    openPosition(acct, o, { shares: fill.shares, costUsd: fill.costUsd, feeUsd: fill.feeUsd, avgPrice: fill.avgPrice }, ctx, nowMs);
    return note(acct, "entered");
  }

  function onTick(ctxs, nowMs) {
    const ctxById = new Map(ctxs.map((c) => [c.eventId, c]));
    for (const acct of accounts.values()) processOrders(acct, ctxById, nowMs);
    for (const ctx of ctxs) {
      if (!ctx.tradeable) continue;
      for (const acct of accounts.values()) decide(acct, ctx, nowMs);
    }
  }

  /**
   * Settle an event. winnerMarketId = null → void (refund).
   * Returns the visible settled positions.
   */
  function settleEvent({ eventId, winnerMarketId, city, kind, nowMs = Date.now() }) {
    const isVoid = winnerMarketId === null;
    const variantAgg = new Map();
    const windowAgg = new Map();
    let cityStake = 0;
    let cityPnl = 0;
    const settled = [];
    for (const acct of accounts.values()) {
      for (const o of acct.orders.filter((x) => x.eventId === eventId)) {
        acct.cash += o.reservedUsd;
        if (!isVoid) recordFill(o, false);
      }
      acct.orders = acct.orders.filter((x) => x.eventId !== eventId);
      for (const k of Object.keys(acct.choices)) if (k.startsWith(`${eventId}|`)) delete acct.choices[k];
      const mine = acct.positions.filter((p) => p.eventId === eventId);
      if (!mine.length) continue;
      acct.positions = acct.positions.filter((p) => p.eventId !== eventId);
      const s = acct.stats;
      for (const p of mine) {
        if (isVoid) {
          acct.cash += p.cost;
          if (!acct.strategy.shadow) {
            s.voids += 1;
            s.fees -= p.fee;
          }
          continue;
        }
        const won = (p.marketId === winnerMarketId) === (p.side === "YES");
        const payout = won ? p.shares : 0;
        const pnl = payout - p.cost;
        acct.cash += payout;
        if (acct.strategy.shadow) {
          const v = variantAgg.get(acct.strategy.id) ?? { stake: 0, pnl: 0 };
          v.stake += p.cost;
          v.pnl += pnl;
          variantAgg.set(acct.strategy.id, v);
          const wk = windowOf(p.leadBin);
          const w = windowAgg.get(wk) ?? { stake: 0, pnl: 0 };
          w.stake += p.cost;
          w.pnl += pnl;
          windowAgg.set(wk, w);
          cityStake += p.cost;
          cityPnl += pnl;
          continue;
        }
        s.bets += 1;
        s.wins += won ? 1 : 0;
        s.pnl += pnl;
        s.staked += p.cost;
        s.expectedPnl += (p.edge ?? 0) * p.shares;
        s.brier += ((p.pSide ?? 0.5) - (won ? 1 : 0)) ** 2;
        const row = { strategyId: acct.strategy.id, ...p, won, payout, pnl, settledAt: nowMs, cashAfter: acct.cash };
        settled.push(row);
        onSettle?.(row);
      }
      if (!acct.strategy.shadow && !isVoid) {
        s.events += 1;
        const eq = equityOf(acct);
        s.peak = Math.max(s.peak, eq);
        s.maxDrawdown = Math.max(s.maxDrawdown, s.peak > 0 ? (s.peak - eq) / s.peak : 0);
        acct.equity.push([nowMs, roundTo(eq, 2)]);
        if (acct.equity.length > 4000) acct.equity.splice(0, acct.equity.length - 4000);
      }
    }
    for (const [k, ev] of fillSeen) if (ev === eventId) fillSeen.delete(k);
    if (isVoid) voidEvents += 1;
    else {
      settledEvents += 1;
      if (learning.enabled) {
        for (const [id, v] of variantAgg) if (v.stake > 0) variantStats.record(id, v.pnl / v.stake, v);
        for (const [id, v] of windowAgg) if (v.stake > 0) windowStats.record(id, v.pnl / v.stake, v);
        if (cityStake > 0) cityStats.record(`${city}|${kind}`, cityPnl / cityStake, { stake: cityStake, pnl: cityPnl });
      }
    }
    return settled;
  }

  function openEventIds() {
    const ids = new Set();
    for (const a of accounts.values()) {
      for (const p of a.positions) ids.add(p.eventId);
      for (const o of a.orders) ids.add(o.eventId);
    }
    return ids;
  }

  /** Markets with a resting bid in any account (their books are needed to check fills). */
  function restingMarketIds() {
    const ids = new Set();
    for (const a of accounts.values()) for (const o of a.orders) ids.add(o.marketId);
    return ids;
  }

  function accountSummary(acct) {
    const s = acct.stats;
    const eq = equityOf(acct);
    return {
      id: acct.strategy.id,
      label: acct.strategy.label,
      risk: acct.strategy.risk,
      description: acct.strategy.description,
      start: acct.start,
      cash: roundTo(acct.cash, 2),
      equity: roundTo(eq, 2),
      roi: (roundTo(eq, 2) - acct.start) / acct.start,
      bets: s.bets,
      events: s.events,
      wins: s.wins,
      winRate: s.bets ? s.wins / s.bets : null,
      pnl: roundTo(s.pnl, 2),
      fees: roundTo(s.fees, 2),
      staked: roundTo(s.staked, 2),
      returnOnStaked: s.staked > 0 ? s.pnl / s.staked : null,
      expectedPnl: roundTo(s.expectedPnl, 2),
      brier: s.bets ? s.brier / s.bets : null,
      maxDrawdown: s.maxDrawdown,
      voids: s.voids,
      makerOrders: s.makerOrders,
      makerFills: s.makerFills,
      openPositions: acct.positions.length,
      restingOrders: acct.orders.length,
      openExposure: roundTo(exposure(acct), 2),
      lastReason: acct.lastReason,
      topReasons: Object.entries(acct.reasons).sort((a, b) => b[1] - a[1]).slice(0, 6),
      equityCurve: acct.equity
    };
  }

  function learningSummary({ cities = [] } = {}) {
    const opt = { lcbZ: learning.lcbZ };
    const variantRows = variants.map((v) => ({ id: v.id, label: v.label, window: v.window, ...variantStats.summary(v.id, opt) })).filter((r) => r.n > 0);
    const proven = variantRows.filter((r) => r.effN >= learning.minEvents && r.lcb > 0);
    const cityKeys = new Set([...cityStats.ids(), ...cities]);
    return {
      enabled: learning.enabled,
      minEvents: learning.minEvents,
      settledEvents,
      voidEvents,
      variantsTested: variantRows.length,
      variantsProven: proven.length,
      variants: variantRows.sort((a, b) => (b.lcb ?? -Infinity) - (a.lcb ?? -Infinity)).slice(0, 15),
      windows: Object.keys(TIMING_WINDOWS).map((w) => ({ window: w, ...windowStats.summary(w, opt) })),
      cities: [...cityKeys].map((k) => {
        const sm = cityStats.summary(k, opt);
        return { key: k, ...sm, ...cityPolicy(sm, learning) };
      }),
      fills: fillModel.table()
    };
  }

  function summary({ includeCurves = false, cities = [] } = {}) {
    const vis = [...accounts.values()].filter((a) => !a.strategy.shadow).map(accountSummary);
    if (!includeCurves) for (const v of vis) delete v.equityCurve;
    const positions = [];
    const orders = [];
    for (const a of accounts.values()) {
      if (a.strategy.shadow) continue;
      for (const p of a.positions) positions.push({ strategyId: a.strategy.id, ...p });
      for (const o of a.orders) orders.push({ strategyId: a.strategy.id, eventId: o.eventId, marketId: o.marketId, side: o.side, price: o.price, reservedUsd: o.reservedUsd, pSide: o.pSide, edge: o.edge, placedAt: o.placedAt, expiresAt: o.expiresAt, leadBin: o.leadBin, variantId: o.variantId });
    }
    return { strategies: vis.sort((a, b) => a.risk - b.risk), learning: learningSummary({ cities }), positions, orders };
  }

  function toJSON() {
    return {
      version: 1,
      settledEvents,
      voidEvents,
      accounts: [...accounts.values()].map((a) => ({
        id: a.strategy.id, cash: a.cash, start: a.start, positions: a.positions, orders: a.orders, choices: a.choices,
        stats: a.stats, reasons: a.reasons, equity: a.equity
      })),
      variantStats: variantStats.toJSON(),
      cityStats: cityStats.toJSON(),
      windowStats: windowStats.toJSON(),
      fillModel: fillModel.toJSON()
    };
  }

  function restore(st) {
    if (!st || st.version !== 1) return false;
    settledEvents = Number(st.settledEvents) || 0;
    voidEvents = Number(st.voidEvents) || 0;
    for (const saved of st.accounts ?? []) {
      const a = accounts.get(saved.id);
      if (!a) continue;
      Object.assign(a, {
        cash: Number(saved.cash), start: Number(saved.start), positions: saved.positions ?? [], orders: saved.orders ?? [],
        choices: saved.choices ?? {}, reasons: saved.reasons ?? {}, equity: saved.equity ?? []
      });
      a.stats = { ...a.stats, ...saved.stats };
    }
    variantStats.restore(st.variantStats);
    cityStats.restore(st.cityStats);
    windowStats.restore(st.windowStats);
    fillModel.restore(st.fillModel);
    return true;
  }

  function resetAccounts() {
    for (const [id, a] of accounts) accounts.set(id, newAccount(a.strategy));
  }

  return { onTick, settleEvent, summary, toJSON, restore, resetAccounts, openEventIds, restingMarketIds, fillModel, variantStats, cityStats, windowStats, variants };
}
