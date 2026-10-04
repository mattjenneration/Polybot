/**
 * History backfill for learning mode: seeds the skill tracker with how each model has actually done at each
 * station, so the engine doesn't start from scratch.
 *
 *   forecasts  Open-Meteo previous runs: each model's forecast made 0–3 days ahead, hourly
 *   realized   IEM METAR archive (same reports the markets resolve on) / HKO Daily Extract for Hong Kong
 *
 * Walk-forward: each day's blend is built from the skill learned on earlier days only, then that day trains
 * the tracker — no look-ahead. Run on demand:  npm run weather:backfill [-- --days 60 --stations KLGA,EGLC]
 * The weather sim also runs it automatically for stations it has no history for.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WCFG } from "./config.js";
import { addDays, localDate, localDayBounds } from "./time.js";
import { dedupeSeries, fetchPreviousRuns } from "./sources/openMeteo.js";
import { fetchIemDailyExtremes } from "./sources/iem.js";
import { fetchHkoDailyExtract } from "./sources/hko.js";
import { windowValues } from "./model/forecast.js";
import { createSkillTracker, fromC, toC } from "./model/skill.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import { errorToRedactedLogString } from "../logRedact.js";
import { sleep } from "../utils.js";

export const BACKFILL_LEAD_BINS = { 0: "d0a", 1: "d1", 2: "d2", 3: "d3" };

async function realizedFor(station, unit, startDate, endDate) {
  if (station.id !== "HKO") return fetchIemDailyExtremes({ station: station.id, tz: station.tz, startDate, endDate, unit });
  const out = new Map();
  for (let d = startDate.slice(0, 7); d <= endDate.slice(0, 7); d = addDays(`${d}-28`, 7).slice(0, 7)) {
    try {
      for (const [k, v] of await fetchHkoDailyExtract(Number(d.slice(0, 4)), Number(d.slice(5, 7)))) if (k >= startDate && k <= endDate) out.set(k, v);
    } catch {
      // month not published yet
    }
  }
  return out;
}

/** Walk-forward skill updates from archived forecasts vs realized extremes. Returns the number of station-days used. */
export function learnFromHistory({ station, unit, kinds, prev, realized, skill }) {
  const leads = [0, 1, 2, 3];
  const byLead = Object.fromEntries(leads.map((lead) => {
    const s = {};
    for (const [m, series] of Object.entries(prev.series)) if (series[lead]) s[m] = series[lead];
    return [lead, dedupeSeries(s)];
  }));
  let used = 0;
  for (const date of [...realized.keys()].sort()) {
    const r = realized.get(date);
    const { startMs, endMs } = localDayBounds(date, station.tz);
    let any = false;
    for (const lead of leads) {
      const bin = BACKFILL_LEAD_BINS[lead];
      for (const kind of kinds) {
        const actual = kind === "high" ? r.max : r.min;
        const raws = {};
        for (const [m, values] of Object.entries(byLead[lead])) {
          const w = windowValues(prev.times, values, startMs, endMs);
          if (w.length >= 20) raws[m] = kind === "high" ? Math.max(...w) : Math.min(...w);
        }
        const names = Object.keys(raws);
        if (!names.length) continue;
        let sw = 0;
        let swx = 0;
        for (const m of names) {
          const sk = skill.get(station.id, kind, `model:${m}`, bin);
          const w = 1 / Math.max(0.25, sk.sd) ** 2;
          sw += w;
          swx += w * (raws[m] - fromC(sk.bias, unit));
        }
        for (const m of names) skill.update(station.id, kind, `model:${m}`, bin, toC(raws[m] - actual, unit));
        skill.update(station.id, kind, "blend", bin, toC(swx / sw - actual, unit));
        any = true;
      }
    }
    if (any) used += 1;
  }
  return used;
}

export async function backfillStation({ station, unit, kinds = ["high", "low"], days = 45, models = WCFG.models, skill, nowMs = Date.now() }) {
  const today = localDate(nowMs, station.tz);
  const startDate = addDays(today, -days);
  const endDate = addDays(today, -1);
  const [realized, prev] = await Promise.all([
    realizedFor(station, unit, startDate, endDate),
    fetchPreviousRuns({ lat: station.lat, lon: station.lon, unit, models, leads: [0, 1, 2, 3], startDate, endDate })
  ]);
  return { days: learnFromHistory({ station, unit, kinds, prev, realized, skill }), realizedDays: realized.size };
}

/** Backfill several stations sequentially (polite to the free APIs). `onProgress` gets a status object. */
export async function backfillStations({ stations, skill, days, onProgress = () => {}, log = () => {} }) {
  const status = { running: true, total: stations.length, done: 0, failed: 0, stationDays: 0, current: null, learned: [], startedAt: new Date().toISOString() };
  onProgress(status);
  for (const { station, unit } of stations) {
    status.current = station.id;
    onProgress(status);
    try {
      const r = await backfillStation({ station, unit, days, skill });
      status.stationDays += r.days;
      if (r.days > 0) status.learned.push(station.id);
      else status.failed += 1;
      log(`backfill ${station.id}: ${r.days} days learned (${r.realizedDays} observed)`);
    } catch (err) {
      status.failed += 1;
      log(`backfill ${station.id} failed: ${errorToRedactedLogString(err)}`);
    }
    status.done += 1;
    onProgress(status);
    await sleep(1500);
  }
  status.running = false;
  status.current = null;
  status.finishedAt = new Date().toISOString();
  onProgress(status);
  return status;
}

// CLI: merges history into the sim's saved skill state (stop the sim first, or it will overwrite on its next save).
async function main() {
  applyGlobalProxyFromEnv();
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const days = Number(arg("--days")) || WCFG.learning.backfillDays;
  const only = arg("--stations")?.split(",").map((s) => s.trim().toUpperCase());
  const stationsFile = path.join(WCFG.logDir, "stations.json");
  const stateFile = path.join(WCFG.logDir, "state.json");
  if (!fs.existsSync(stationsFile)) {
    console.error(`No ${stationsFile} yet — start the weather sim once (npm run sim:weather) so it discovers stations.`);
    process.exit(1);
  }
  const stations = JSON.parse(fs.readFileSync(stationsFile, "utf8"));
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  const skill = createSkillTracker();
  skill.restore(state.skill);
  const list = Object.values(stations)
    .filter((s) => s.lat && s.tz && (!only || only.includes(s.id)))
    .map((s) => ({ station: s, unit: s.unit ?? (s.id.startsWith("K") ? "F" : "C") }));
  const st = await backfillStations({ stations: list, skill, days, log: (m) => console.log(m) });
  state.skill = skill.toJSON();
  fs.mkdirSync(WCFG.logDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log(`done: ${st.done} stations, ${st.stationDays} station-days, ${st.failed} failed → ${stateFile}`);
}

const entryPath = process.env.pm_exec_path || process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((err) => {
    console.error("[weather-backfill] fatal:", errorToRedactedLogString(err));
    process.exit(1);
  });
}
