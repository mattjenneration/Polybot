import { CONFIG } from "../config.js";
import { fetchMarketBySlug, parseResolvedUpDownFromGammaMarket } from "../data/polymarket.js";
import { rewriteRollingCsvByLeadingTimestampMs } from "../utils.js";

const SAMPLE_CSV_HEADER = [
  "ts_ms",
  "round_key",
  "round_start_ms",
  "round_end_ms",
  "up_bid",
  "down_bid",
  "up_cents",
  "down_cents",
  "leader",
  "confidence_score",
  "confidence_direction",
  "ta_score",
  "swing_events_json"
];

const ROUND_CSV_HEADER = [
  "finalized_at_ms",
  "round_key",
  "round_start_ms",
  "round_end_ms",
  "outcome",
  "lead_flips",
  "bid_cent_moves",
  "sample_count",
  "up_leader_frac",
  "final_leader",
  "terminal_match",
  "mean_confidence"
];

const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_SAMPLE_MS = 10_000;

function toFiniteNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** Polymarket bids are quoted ~0–1; snap to cents for swing notes. */
export function bidToCents(n) {
  const v = toFiniteNumber(n);
  if (v === null) return null;
  return Math.round(v * 100) / 100;
}

function leaderFromCents(upC, downC) {
  if (upC === null || downC === null) return null;
  if (upC > downC) return "UP";
  if (downC > upC) return "DOWN";
  return "TIE";
}

function purgeByTime({ samples, completedRounds, cutoffMs }) {
  return {
    samples: samples.filter((s) => s.ts >= cutoffMs),
    completedRounds: completedRounds.filter((r) => (r.finalizedAtMs ?? r.endMs ?? 0) >= cutoffMs)
  };
}

function buildSwingEvents(prev, upC, downC, L, tsNow) {
  if (!prev) return [];
  const out = [];
  if (prev.leader && L && prev.leader !== "TIE" && L !== "TIE" && prev.leader !== L) {
    out.push({ type: "lead_flip", from: prev.leader, to: L, ts: tsNow });
  }
  if (prev.upCents !== null && upC !== null && prev.upCents !== upC) {
    out.push({ type: "up_bid_cent", from: prev.upCents, to: upC, ts: tsNow });
  }
  if (prev.downCents !== null && downC !== null && prev.downCents !== downC) {
    out.push({ type: "down_bid_cent", from: prev.downCents, to: downC, ts: tsNow });
  }
  return out;
}

function aggregateSamplesForContext(samples) {
  let leadFlips = 0;
  let bidCentMoves = 0;
  let upCount = 0;
  let dirCount = 0;
  let confSum = 0;
  let confN = 0;

  for (const s of samples) {
    for (const ev of s.swingEvents || []) {
      if (ev.type === "lead_flip") leadFlips += 1;
      if (ev.type === "up_bid_cent" || ev.type === "down_bid_cent") bidCentMoves += 1;
    }
    if (s.leader === "UP") {
      upCount += 1;
      dirCount += 1;
    } else if (s.leader === "DOWN") {
      dirCount += 1;
    }
    if (s.confidenceScore !== null && Number.isFinite(Number(s.confidenceScore))) {
      confSum += Number(s.confidenceScore);
      confN += 1;
    }
  }

  const upLeaderFrac = dirCount > 0 ? upCount / dirCount : 0.5;
  const meanConfidence = confN > 0 ? confSum / confN : null;

  return {
    sampleCount: samples.length,
    leadFlips,
    bidCentMoves,
    upLeaderFrac,
    meanConfidence
  };
}

/**
 * Rolling Polymarket Up/Down best-bid log (10s cadence), 1h retention, per-round swings + resolved outcomes.
 */
export function createPolySwingsCollector(options = {}) {
  const retentionMs = Number(options.retentionMs ?? DEFAULT_RETENTION_MS);
  const sampleIntervalMs = Number(options.sampleIntervalMs ?? DEFAULT_SAMPLE_MS);
  const upLabel = options.upLabel ?? CONFIG.polymarket.upOutcomeLabel;
  const downLabel = options.downLabel ?? CONFIG.polymarket.downOutcomeLabel;
  const csvEnabled = options.csvEnabled ?? CONFIG.polymarket.polySwingsCsvEnabled;
  const csvSamplesPath = options.csvSamplesPath ?? CONFIG.polymarket.polySwingsCsvPath;
  const csvRoundsPath =
    options.csvRoundsPath ??
    String(csvSamplesPath).replace(/\.csv$/i, "_rounds.csv");

  let samples = [];
  let completedRounds = [];
  let lastSampleAtMs = 0;
  let previousSlug = null;
  /** Last row per slug for swing detection (survives purge of older rows for that slug). */
  let lastBySlug = new Map();

  function getContextForIndicator(nowMs = Date.now()) {
    const cutoff = nowMs - retentionMs;
    const pruned = purgeByTime({ samples, completedRounds, cutoffMs: cutoff });
    samples = pruned.samples;
    completedRounds = pruned.completedRounds;

    const windowSamples = samples.filter((s) => s.ts >= cutoff);
    const windowRounds = completedRounds.filter((r) => (r.finalizedAtMs ?? r.endMs ?? 0) >= cutoff);
    const stats = aggregateSamplesForContext(windowSamples);

    const roundsWithOutcome = windowRounds.filter((r) => r.outcome === "UP" || r.outcome === "DOWN").length;
    const terminalMatches = windowRounds.filter((r) => r.terminalMatch === true).length;
    const terminalEval = windowRounds.filter((r) => r.terminalMatch === true || r.terminalMatch === false).length;

    return {
      hasData: stats.sampleCount >= 4,
      retentionMs,
      sampleIntervalMs,
      ...stats,
      completedRoundCount: windowRounds.length,
      roundsWithOutcome,
      terminalAccuracy: terminalEval > 0 ? terminalMatches / terminalEval : null,
      recentRounds: windowRounds.slice(-12).map((r) => ({
        roundKey: r.roundKey,
        outcome: r.outcome,
        leadFlips: r.leadFlips,
        bidCentMoves: r.bidCentMoves,
        sampleCount: r.sampleCount,
        finalLeader: r.finalLeader,
        terminalMatch: r.terminalMatch
      }))
    };
  }

  async function finalizeRound(slug, nowMs) {
    let outcome = null;
    try {
      const m = await fetchMarketBySlug(slug);
      outcome = parseResolvedUpDownFromGammaMarket(m, upLabel, downLabel);
    } catch {
      outcome = null;
    }

    const rs = samples.filter((s) => s.roundKey === slug).sort((a, b) => a.ts - b.ts);
    let leadFlips = 0;
    let bidCentMoves = 0;
    for (const s of rs) {
      for (const ev of s.swingEvents || []) {
        if (ev.type === "lead_flip") leadFlips += 1;
        if (ev.type === "up_bid_cent" || ev.type === "down_bid_cent") bidCentMoves += 1;
      }
    }
    const upLeaders = rs.filter((s) => s.leader === "UP").length;
    const dirSamples = rs.filter((s) => s.leader === "UP" || s.leader === "DOWN").length;
    const upLeaderFrac = dirSamples > 0 ? upLeaders / dirSamples : null;
    const last = rs.length ? rs[rs.length - 1] : null;
    const finalLeader = last?.leader ?? null;
    const terminalMatch =
      outcome && finalLeader && (finalLeader === "UP" || finalLeader === "DOWN")
        ? finalLeader === outcome
        : null;
    const endMs = last?.roundEndMs ?? last?.ts ?? nowMs;
    const startMs = last?.roundStartMs ?? (rs.length ? rs[0].roundStartMs : null);

    let confSum = 0;
    let confN = 0;
    for (const s of rs) {
      if (s.confidenceScore !== null && Number.isFinite(Number(s.confidenceScore))) {
        confSum += Number(s.confidenceScore);
        confN += 1;
      }
    }

    const roundRecord = {
      roundKey: slug,
      startMs,
      endMs,
      finalizedAtMs: nowMs,
      outcome,
      sampleCount: rs.length,
      leadFlips,
      bidCentMoves,
      upLeaderFrac,
      finalLeader,
      terminalMatch,
      meanConfidence: confN > 0 ? confSum / confN : null
    };
    completedRounds.push(roundRecord);

    if (csvEnabled) {
      try {
        const cutoff = nowMs - retentionMs;
        rewriteRollingCsvByLeadingTimestampMs(
          csvRoundsPath,
          ROUND_CSV_HEADER,
          [
            roundRecord.finalizedAtMs,
            roundRecord.roundKey,
            roundRecord.startMs ?? "",
            roundRecord.endMs ?? "",
            roundRecord.outcome ?? "",
            roundRecord.leadFlips,
            roundRecord.bidCentMoves,
            roundRecord.sampleCount,
            roundRecord.upLeaderFrac ?? "",
            roundRecord.finalLeader ?? "",
            roundRecord.terminalMatch === null || roundRecord.terminalMatch === undefined
              ? ""
              : roundRecord.terminalMatch,
            roundRecord.meanConfidence ?? ""
          ],
          cutoff
        );
      } catch {
        // ignore csv errors
      }
    }
  }

  async function tick({ poly, confidence, taScore, nowMs = Date.now() }) {
    const cutoff = nowMs - retentionMs;
    const pruned = purgeByTime({ samples, completedRounds, cutoffMs: cutoff });
    samples = pruned.samples;
    completedRounds = pruned.completedRounds;

    if (!poly?.ok || !poly.market) return;

    const slug = String(poly.market.slug ?? "");
    if (!slug) return;

    if (previousSlug !== null && previousSlug !== slug) {
      await finalizeRound(previousSlug, nowMs);
      lastBySlug.delete(previousSlug);
    }
    previousSlug = slug;

    if (nowMs - lastSampleAtMs < sampleIntervalMs) return;
    lastSampleAtMs = nowMs;

    const upBid = poly.orderbook?.up?.bestBid ?? null;
    const downBid = poly.orderbook?.down?.bestBid ?? null;
    const upC = bidToCents(upBid);
    const downC = bidToCents(downBid);
    const L = leaderFromCents(upC, downC);

    const roundStartMs = poly.market.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;
    const roundEndMs = poly.market.endDate ? new Date(poly.market.endDate).getTime() : null;

    const prevRow = lastBySlug.get(slug);
    const swingEvents = buildSwingEvents(prevRow ?? null, upC, downC, L, nowMs);

    const row = {
      ts: nowMs,
      roundKey: slug,
      roundStartMs,
      roundEndMs,
      upBid: toFiniteNumber(upBid),
      downBid: toFiniteNumber(downBid),
      upCents: upC,
      downCents: downC,
      leader: L,
      confidenceScore: confidence?.score ?? null,
      confidenceDirection: confidence?.direction ?? null,
      taScore: taScore ?? null,
      swingEvents
    };

    samples.push(row);
    lastBySlug.set(slug, {
      ts: nowMs,
      upCents: upC,
      downCents: downC,
      leader: L
    });

    if (csvEnabled) {
      try {
        rewriteRollingCsvByLeadingTimestampMs(
          csvSamplesPath,
          SAMPLE_CSV_HEADER,
          [
            row.ts,
            row.roundKey,
            row.roundStartMs ?? "",
            row.roundEndMs ?? "",
            row.upBid ?? "",
            row.downBid ?? "",
            row.upCents ?? "",
            row.downCents ?? "",
            row.leader ?? "",
            row.confidenceScore ?? "",
            row.confidenceDirection ?? "",
            row.taScore ?? "",
            JSON.stringify(row.swingEvents ?? [])
          ],
          nowMs - retentionMs
        );
      } catch {
        // ignore csv errors
      }
    }
  }

  return {
    getContextForIndicator,
    tick
  };
}
