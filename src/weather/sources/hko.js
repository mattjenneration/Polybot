/**
 * Hong Kong Observatory open data. Hong Kong markets resolve on HKO's "Absolute Daily Max/Min" (0.1 °C,
 * truncated to the whole degree), not on a METAR station.
 */
const HKO_DATA = process.env.HKO_DATA_URL || "https://data.weather.gov.hk";
const HKO_WWW = process.env.HKO_WWW_URL || "https://www.hko.gov.hk";
export const HKO_STATION = { id: "HKO", lat: 22.3019, lon: 114.1742, tz: "Asia/Hong_Kong", name: "Hong Kong Observatory" };

const HKT_OFFSET_MS = 8 * 3_600_000;

async function get(url, as = "json") {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0 (polybot weather sim)" } });
  if (!res.ok) throw new Error(`HKO ${new URL(url).pathname} HTTP ${res.status}`);
  return as === "json" ? res.json() : res.text();
}

/** Max/min since local midnight at the Observatory: { asOfMs, date, max, min }. */
export async function fetchHkoSinceMidnight() {
  const csv = await get(`${HKO_DATA}/weatherAPI/hko_data/regional-weather/latest_since_midnight_maxmin.csv`, "text");
  const row = csv.split(/\r?\n/).map((l) => l.split(",")).find((c) => /^HK Observatory$/i.test(String(c[1] ?? "").trim()));
  if (!row) return null;
  const s = row[0].trim();
  const asOfMs = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12))) - HKT_OFFSET_MS;
  const max = Number(row[2]);
  const min = Number(row[3]);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(max) || !Number.isFinite(min)) return null;
  return { asOfMs, date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, max, min };
}

/** Latest hourly reading at the Observatory: { tMs, c }. */
export async function fetchHkoCurrent() {
  const d = await get(`${HKO_DATA}/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en`);
  const v = (d?.temperature?.data ?? []).find((x) => x.place === "Hong Kong Observatory");
  const tMs = Date.parse(d?.temperature?.recordTime ?? d?.updateTime ?? "");
  if (!v || !Number.isFinite(Number(v.value)) || !Number.isFinite(tMs)) return null;
  return { tMs, c: Number(v.value) };
}

/** Daily Extract (the resolution source) for a month: Map "YYYY-MM-DD" → { max, min }. */
export async function fetchHkoDailyExtract(year, month) {
  const ym = `${year}${String(month).padStart(2, "0")}`;
  const d = await get(`${HKO_WWW}/cis/dailyExtract/dailyExtract_${ym}.xml`);
  const out = new Map();
  for (const row of d?.stn?.data?.[0]?.dayData ?? []) {
    const day = Number(row[0]);
    const max = Number(row[2]);
    const min = Number(row[4]);
    if (!Number.isInteger(day) || !Number.isFinite(max) || !Number.isFinite(min)) continue;
    out.set(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, { max, min });
  }
  return out;
}
