/**
 * Strategy presets, ordered safe → risky.
 *
 * Every strategy answers the same question each tick: "given my probability estimate for UP,
 * is there a side I can buy for less than it's worth after fees, inside my entry window?"
 *
 * Fields:
 *   probSource        "fair" (volatility model) | "learned" (online model) | "market" (control)
 *   execution         "taker" (cross the spread, pays fee) | "maker" (rest a bid, no fee, may not fill)
 *   minEdge           required expected profit per share after fees, in $ (0.03 = 3¢ per $1 share)
 *   windowSec         [min, max] seconds-left when entries are allowed
 *   priceBand         [min, max] share price we're willing to pay
 *   maxModelMarketGap skip when |model − market| is larger than this (usually bad data, not edge)
 *   sizing            { mode: "fixed", usd } | { mode: "kelly", fraction, maxPctBankroll, maxUsd }
 *   maxBetsPerRound   entries per round (same side only)
 *   minSecondsBetweenBets
 */
export const STRATEGY_PRESETS = [
  {
    id: "naive-favorite",
    label: "Naive favorite (control)",
    risk: 0,
    description: "What a casual player does: buy whichever side is favored with ~60s left. No edge check. Baseline to beat.",
    probSource: "market",
    execution: "taker",
    minEdge: -1,
    windowSec: [45, 60],
    priceBand: [0.5, 0.99],
    maxModelMarketGap: 1,
    sizing: { mode: "fixed", usd: 2 },
    maxBetsPerRound: 1,
    minSecondsBetweenBets: 0
  },
  {
    id: "conservative",
    label: "Conservative",
    risk: 1,
    description: "Volatility model only, favorites only, large edge, small stakes.",
    probSource: "fair",
    execution: "taker",
    minEdge: 0.04,
    windowSec: [15, 90],
    priceBand: [0.6, 0.94],
    maxModelMarketGap: 0.2,
    sizing: { mode: "kelly", fraction: 0.1, maxPctBankroll: 0.03, maxUsd: 5 },
    maxBetsPerRound: 1,
    minSecondsBetweenBets: 0
  },
  {
    id: "maker-patient",
    label: "Maker (patient)",
    risk: 2,
    description: "Rests bids below fair value instead of paying the spread and taker fee. Fewer fills, cheaper fills.",
    probSource: "fair",
    execution: "maker",
    minEdge: 0.03,
    windowSec: [20, 240],
    priceBand: [0.55, 0.95],
    maxModelMarketGap: 0.2,
    sizing: { mode: "kelly", fraction: 0.15, maxPctBankroll: 0.04, maxUsd: 6 },
    maxBetsPerRound: 2,
    minSecondsBetweenBets: 20
  },
  {
    id: "balanced",
    label: "Balanced",
    risk: 3,
    description: "Learned probability, moderate edge, either side of 50¢.",
    probSource: "learned",
    execution: "taker",
    minEdge: 0.025,
    windowSec: [10, 150],
    priceBand: [0.35, 0.96],
    maxModelMarketGap: 0.25,
    sizing: { mode: "kelly", fraction: 0.2, maxPctBankroll: 0.05, maxUsd: 10 },
    maxBetsPerRound: 2,
    minSecondsBetweenBets: 20
  },
  {
    id: "aggressive",
    label: "Aggressive",
    risk: 4,
    description: "Learned probability, thin edge, wide window, bigger Kelly fraction.",
    probSource: "learned",
    execution: "taker",
    minEdge: 0.015,
    windowSec: [5, 240],
    priceBand: [0.1, 0.97],
    maxModelMarketGap: 0.35,
    sizing: { mode: "kelly", fraction: 0.35, maxPctBankroll: 0.08, maxUsd: 20 },
    maxBetsPerRound: 4,
    minSecondsBetweenBets: 10
  },
  {
    id: "degen",
    label: "Degen",
    risk: 5,
    description: "Takes almost any positive edge including long shots. Shows what over-trading costs.",
    probSource: "learned",
    execution: "taker",
    minEdge: 0.005,
    windowSec: [3, 285],
    priceBand: [0.02, 0.99],
    maxModelMarketGap: 0.5,
    sizing: { mode: "kelly", fraction: 0.5, maxPctBankroll: 0.12, maxUsd: 40 },
    maxBetsPerRound: 6,
    minSecondsBetweenBets: 5
  }
];

/**
 * Shadow variants the adaptive strategy learns from. Each is paper-traded with a tiny fixed stake
 * so their per-$ returns are comparable; they are hidden from the leaderboard.
 */
export function buildShadowVariants() {
  const variants = [];
  const probSources = ["fair", "learned"];
  const edges = [0.01, 0.025, 0.05];
  const windows = [[5, 45], [30, 120], [100, 280]];
  const bands = [[0.05, 0.5], [0.5, 0.97]];
  for (const probSource of probSources) {
    for (const minEdge of edges) {
      for (const windowSec of windows) {
        for (const priceBand of bands) {
          variants.push({
            id: `v:${probSource}:e${minEdge}:w${windowSec.join("-")}:p${priceBand.join("-")}`,
            label: `${probSource} e≥${minEdge} ${windowSec.join("–")}s ${priceBand.join("–")}`,
            shadow: true,
            probSource,
            execution: "taker",
            minEdge,
            windowSec,
            priceBand,
            maxModelMarketGap: 0.3,
            sizing: { mode: "fixed", usd: 1 },
            maxBetsPerRound: 1,
            minSecondsBetweenBets: 0
          });
        }
      }
    }
  }
  return variants;
}

export const ADAPTIVE_STRATEGY = {
  id: "adaptive",
  label: "Adaptive (learning)",
  risk: 3,
  description: "Each round picks the shadow variant with the best recent risk-adjusted return (Thompson sampling). Sits out until a variant has proven itself.",
  adaptive: true,
  execution: "taker",
  sizing: { mode: "kelly", fraction: 0.2, maxPctBankroll: 0.05, maxUsd: 10 },
  maxBetsPerRound: 1,
  minSecondsBetweenBets: 0
};

export function selectStrategies(ids) {
  const all = [...STRATEGY_PRESETS, ADAPTIVE_STRATEGY];
  if (!ids || ids.includes("all")) return all;
  const picked = all.filter((s) => ids.includes(s.id));
  // The adaptive strategy relies on shadow variants, which are always added by the engine.
  return picked.length ? picked : all;
}
