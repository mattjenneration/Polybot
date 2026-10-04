/**
 * Forecast skill tracker: decay-weighted bias and error sd of every forecast source (each NWP model, the
 * blend, the nowcast, the ensemble) per station × kind (high/low) × lead bin.
 *
 * Errors are stored in °C (°F errors ÷ 1.8) so stations can pool. Estimates shrink hierarchically:
 * station → all stations → a lead-time prior, so a new station starts from the global picture and moves
 * toward its own record as days settle. Seeded from history by backfill.js, then updated live.
 */
import { clamp } from "../../core/math.js";

/** Prior error sd (°C) of a day-extreme forecast by lead, before any history. */
export const PRIOR_SD_C = { d3: 2.4, d2: 2.0, d1: 1.6, d0a: 1.3, d0b: 1.0, d0c: 0.75, d0d: 0.5, post: 0.2 };
export const toC = (delta, unit) => (unit === "F" ? delta / 1.8 : delta);
export const fromC = (delta, unit) => (unit === "F" ? delta * 1.8 : delta);

export function createSkillTracker({ halfLife = 45, priorWeight = 5 } = {}) {
  const decay = 2 ** (-1 / halfLife);
  const stats = new Map(); // key → { w, n, mean, m2 }
  const key = (station, kind, source, bin) => `${station}|${kind}|${source}|${bin}`;

  function add(k, x) {
    const s = stats.get(k) ?? { w: 0, n: 0, mean: 0, m2: 0 };
    s.w = decay * s.w + 1;
    s.m2 *= decay;
    const d = x - s.mean;
    s.mean += d / s.w;
    s.m2 += d * (x - s.mean);
    s.n += 1;
    stats.set(k, s);
  }

  /** Record one forecast error (forecast − realized), in °C. */
  function update(station, kind, source, bin, errC) {
    if (!Number.isFinite(errC)) return;
    const e = clamp(errC, -15, 15);
    add(key(station, kind, source, bin), e);
    add(key("*", kind, source, bin), e);
  }

  function raw(k) {
    const s = stats.get(k);
    if (!s || s.w <= 0) return null;
    return { w: s.w, n: s.n, mean: s.mean, var: s.w > 1.5 ? s.m2 / (s.w - 1) : null };
  }

  function shrink(r, prior, k) {
    if (!r) return prior;
    const wv = Math.max(0, r.w - 1);
    return {
      bias: (r.w * r.mean + k * prior.bias) / (r.w + k),
      var: r.var === null ? prior.var : (wv * r.var + k * prior.var) / (wv + k)
    };
  }

  /** Shrunk { n, bias, sd } in °C. `fallback` sources stand in when this source has no record at all. */
  function get(station, kind, source, bin, { fallback = [] } = {}) {
    const prior = { bias: 0, var: (PRIOR_SD_C[bin] ?? 1.5) ** 2 };
    for (const src of [source, ...fallback]) {
      const g = raw(key("*", kind, src, bin));
      const s = raw(key(station, kind, src, bin));
      if (!g && !s) continue;
      const global = shrink(g, prior, priorWeight * 2);
      const local = shrink(s, global, priorWeight);
      return { n: s?.n ?? 0, nGlobal: g?.n ?? 0, bias: local.bias, sd: Math.sqrt(Math.max(0.01, local.var)), source: src };
    }
    return { n: 0, nGlobal: 0, bias: 0, sd: Math.sqrt(prior.var), source: "prior" };
  }

  /** Pooled (all-station) stats per source and bin, for the dashboard. */
  function globalTable() {
    const rows = [];
    for (const [k, s] of stats) {
      const [station, kind, source, bin] = k.split("|");
      if (station !== "*") continue;
      rows.push({ kind, source, bin, n: s.n, bias: s.mean, sd: s.w > 1.5 ? Math.sqrt(s.m2 / (s.w - 1)) : null });
    }
    return rows;
  }

  /** Per-station stats for one source/bin (e.g. the blend at d1), for the dashboard. */
  function stationTable(source, bin) {
    const rows = [];
    for (const [k, s] of stats) {
      const [station, kind, src, b] = k.split("|");
      if (station === "*" || src !== source || b !== bin) continue;
      rows.push({ station, kind, n: s.n, bias: s.mean, sd: s.w > 1.5 ? Math.sqrt(s.m2 / (s.w - 1)) : null });
    }
    return rows;
  }

  function samples(station) {
    let n = 0;
    for (const [k, s] of stats) if (k.startsWith(`${station}|`)) n += s.n;
    return n;
  }

  return {
    update,
    get,
    globalTable,
    stationTable,
    samples,
    toJSON: () => Object.fromEntries(stats),
    restore(state) {
      for (const [k, v] of Object.entries(state ?? {})) stats.set(k, { w: 0, n: 0, mean: 0, m2: 0, ...v });
    }
  };
}
