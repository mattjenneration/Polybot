/** Iowa Environmental Mesonet ASOS/METAR archive (global) — realized daily extremes for the history backfill. */
import { addDays } from "../time.js";

const IEM = process.env.IEM_URL || "https://mesonet.agron.iastate.edu";

/** IEM ids drop the K prefix for US stations (KLGA → LGA) and use the ICAO elsewhere. */
export const iemStationId = (icao) => (/^K[A-Z0-9]{3}$/.test(icao) ? icao.slice(1) : icao);

/**
 * Daily max/min per local date from routine + special METARs, in the market's unit.
 * Days with gaps over 3 hours are dropped (an extreme could hide in the gap).
 */
export async function fetchIemDailyExtremes({ station, tz, startDate, endDate, unit }) {
  const [y1, m1, d1] = startDate.split("-").map(Number);
  // IEM's end date is exclusive
  const [y2, m2, d2] = addDays(endDate, 1).split("-").map(Number);
  const url = new URL("/cgi-bin/request/asos.py", IEM);
  const params = {
    station: iemStationId(station), data: unit === "F" ? "tmpf" : "tmpc", year1: y1, month1: m1, day1: d1,
    year2: y2, month2: m2, day2: d2, tz, format: "onlycomma", latlon: "no", missing: "M", trace: "T", direct: "no"
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.append("report_type", "3");
  url.searchParams.append("report_type", "4");
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`IEM ${station} HTTP ${res.status}`);
  const lines = (await res.text()).trim().split("\n").slice(1);
  const days = new Map();
  for (const line of lines) {
    const [, valid, val] = line.split(",");
    const v = Number(val);
    if (!valid || val === "M" || !Number.isFinite(v)) continue;
    const date = valid.slice(0, 10);
    const minutes = Number(valid.slice(11, 13)) * 60 + Number(valid.slice(14, 16));
    const d = days.get(date) ?? { max: -Infinity, min: Infinity, n: 0, times: [] };
    d.max = Math.max(d.max, v);
    d.min = Math.min(d.min, v);
    d.n += 1;
    d.times.push(minutes);
    days.set(date, d);
  }
  const out = new Map();
  for (const [date, d] of days) {
    const t = d.times.sort((a, b) => a - b);
    let maxGap = Math.max(t[0], 1440 - t[t.length - 1]);
    for (let i = 1; i < t.length; i += 1) maxGap = Math.max(maxGap, t[i] - t[i - 1]);
    if (maxGap <= 180) out.set(date, { max: d.max, min: d.min, n: d.n });
  }
  return out;
}
