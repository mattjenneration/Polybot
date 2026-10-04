/**
 * Weather strategies, ordered safe → risky. Each answers: "is there a bucket side I can buy for less than it's
 * worth (after fees), inside my timing window?"
 *
 *   probSource   "final" (learned model+market blend) | "wx" (weather model only) | "market" (control)
 *   execution    "taker" (cross the spread, pays fee) | "maker" (rest the best-EV bid, no fee, may not fill)
 *   windows      lead bins when entries are allowed: d3 d2 d1 (days ahead), d0a–d0d (on the day, by hours
 *                left: >12, 6–12, 2–6, <2), post (local day over, outcome observed, market not yet settled)
 *   minEdge      required expected profit per share after fees
 *   minProbSide  only buy sides at least this likely (snipers / tail faders)
 *   maxGap       skip when |p − market| exceeds this (usually a data problem, not an edge)
 *   sizing       { mode: "fixed", usd } | { mode: "kelly", fraction, maxPct, maxUsd }
 */
const kelly = (fraction, maxPct, maxUsd) => ({ mode: "kelly", fraction, maxPct, maxUsd });

export const WEATHER_STRATEGIES = [
  {
    id: "market-favorite",
    label: "Market favourite (control)",
    risk: 0,
    description: "Buys the market's favourite bucket the day before. No model, no edge check. The baseline to beat.",
    probSource: "market",
    execution: "taker",
    windows: ["d1"],
    sides: ["YES"],
    minEdge: -1,
    priceBand: [0.2, 0.75],
    favoriteOnly: true,
    sizing: { mode: "fixed", usd: 10 },
    maxPerEvent: 1
  },
  {
    id: "nowcast-sniper",
    label: "Nowcast sniper",
    risk: 1,
    description: "Same day only. Once observations pin the outcome (e.g. the high has already passed a bucket), buys near-certain sides the market hasn't fully priced.",
    probSource: "final",
    execution: "taker",
    windows: ["d0b", "d0c", "d0d", "post"],
    sides: ["YES", "NO"],
    minEdge: 0.02,
    minProbSide: 0.9,
    priceBand: [0.5, 0.995],
    maxGap: 0.5,
    sizing: kelly(0.25, 0.04, 40),
    maxPerEvent: 3
  },
  {
    id: "forecast-taker",
    label: "Forecast taker",
    risk: 2,
    description: "Learned model+market probability. Crosses the spread when the edge after fees is at least 6¢. Day before and morning of.",
    probSource: "final",
    execution: "taker",
    windows: ["d1", "d0a", "d0b"],
    sides: ["YES", "NO"],
    minEdge: 0.06,
    priceBand: [0.04, 0.96],
    maxGap: 0.35,
    sizing: kelly(0.15, 0.02, 25),
    maxPerEvent: 2
  },
  {
    id: "maker-bidder",
    label: "Maker bidder",
    risk: 2,
    description: "Rests the bid with the best expected value (learned fill rate × edge) instead of paying the spread and taker fee.",
    probSource: "final",
    execution: "maker",
    windows: ["d2", "d1", "d0a", "d0b"],
    sides: ["YES", "NO"],
    minEdge: 0.05,
    priceBand: [0.03, 0.95],
    maxGap: 0.35,
    sizing: kelly(0.15, 0.02, 25),
    maxPerEvent: 2,
    makerTtlMin: 120
  },
  {
    id: "tail-fader",
    label: "Tail fader",
    risk: 3,
    description: "Sells long shots: buys NO on buckets the model puts at 10% or less that the market prices higher.",
    probSource: "final",
    execution: "taker",
    windows: ["d2", "d1", "d0a"],
    sides: ["NO"],
    minEdge: 0.03,
    minProbSide: 0.9,
    priceBand: [0.5, 0.97],
    maxGap: 0.35,
    sizing: kelly(0.2, 0.03, 30),
    maxPerEvent: 3
  },
  {
    id: "model-only",
    label: "Weather model only",
    risk: 3,
    description: "Ignores the market price: pure forecast probability, edge of at least 8¢. Shows whether the forecast alone beats the crowd.",
    probSource: "wx",
    execution: "taker",
    windows: ["d2", "d1", "d0a", "d0b"],
    sides: ["YES", "NO"],
    minEdge: 0.08,
    priceBand: [0.04, 0.96],
    maxGap: 0.6,
    sizing: kelly(0.1, 0.02, 20),
    maxPerEvent: 2
  }
];

export const LEARNING_STRATEGY = {
  id: "learning",
  label: "Learning mode",
  risk: 2,
  description: "Follows whichever shadow variant has proven an edge for this timing window (Thompson sampling), sized by Kelly × confidence × the city's learned multiplier. Sits out until a variant has proven itself.",
  adaptive: true,
  sizing: kelly(0.2, 0.03, 40),
  maxPerEvent: 3,
  makerTtlMin: 120
};

export const TIMING_WINDOWS = {
  early: ["d3", "d2"],
  d1: ["d1"],
  "d0-early": ["d0a", "d0b"],
  "d0-late": ["d0c", "d0d", "post"]
};

/**
 * Shadow variants learning mode explores, each paper-traded with a small fixed stake so their returns per $
 * compare. 2 probability sources × 3 edge thresholds × 4 timing windows × 2 sides × 2 executions = 96.
 */
export function buildShadowVariants(stakeUsd = 1) {
  const out = [];
  for (const probSource of ["final", "wx"]) {
    for (const minEdge of [0.03, 0.06, 0.12]) {
      for (const [win, windows] of Object.entries(TIMING_WINDOWS)) {
        for (const side of ["YES", "NO"]) {
          for (const execution of ["taker", "maker"]) {
            out.push({
              id: `v:${probSource}:e${minEdge}:${win}:${side}:${execution}`,
              label: `${probSource} ≥${Math.round(minEdge * 100)}¢ ${win} ${side} ${execution}`,
              shadow: true,
              probSource,
              execution,
              windows,
              window: win,
              sides: [side],
              minEdge,
              priceBand: [0.02, 0.98],
              maxGap: probSource === "wx" ? 0.5 : 0.35,
              sizing: { mode: "fixed", usd: stakeUsd },
              maxPerEvent: 1,
              makerTtlMin: 120
            });
          }
        }
      }
    }
  }
  return out;
}

export function selectStrategies(ids) {
  const all = [...WEATHER_STRATEGIES, LEARNING_STRATEGY];
  if (!ids || ids.includes("all")) return all;
  const picked = all.filter((s) => ids.includes(s.id));
  return picked.length ? picked : all;
}
