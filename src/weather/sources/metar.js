/** Live METARs from aviationweather.gov — the observations NOAA's timeseries (the resolution source) shows. */
const AVIATION_WEATHER = process.env.AVIATION_WEATHER_URL || "https://aviationweather.gov";

/** METAR temperature in °C, using the T-group tenths (e.g. T02560178 → 25.6) when present. */
export function metarTempC(obs) {
  const t = /\bT([01])(\d{3})[01]\d{3}\b/.exec(String(obs?.rawOb || ""));
  if (t) return (t[1] === "1" ? -1 : 1) * Number(t[2]) / 10;
  const n = Number(obs?.temp);
  return obs?.temp !== null && obs?.temp !== undefined && Number.isFinite(n) ? n : null;
}

export const cToUnit = (c, unit) => (unit === "F" ? c * 9 / 5 + 32 : c);

// aviationweather.gov silently truncates a response at this many reports.
const RESPONSE_CAP = 400;

async function fetchChunk(chunk, hours) {
  const url = new URL("/api/data/metar", AVIATION_WEATHER);
  url.searchParams.set("ids", chunk.join(","));
  url.searchParams.set("format", "json");
  url.searchParams.set("hours", String(hours));
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`aviationweather metar HTTP ${res.status}`);
  const data = res.status === 204 ? [] : await res.json();
  const rows = Array.isArray(data) ? data : [];
  if (rows.length >= RESPONSE_CAP && chunk.length > 1) {
    const mid = Math.ceil(chunk.length / 2);
    return [...(await fetchChunk(chunk.slice(0, mid), hours)), ...(await fetchChunk(chunk.slice(mid), hours))];
  }
  return rows;
}

/** Map ICAO → [{ tMs, c }] sorted by time, for the last `hours` hours. Batches split when they hit the cap. */
export async function fetchMetars(ids, { hours = 30, batch = 25 } = {}) {
  const out = new Map();
  const uniq = [...new Set(ids.filter((id) => /^[A-Z0-9]{4}$/.test(id)))];
  for (let i = 0; i < uniq.length; i += batch) {
    const data = await fetchChunk(uniq.slice(i, i + batch), hours);
    for (const o of data) {
      const id = String(o?.icaoId ?? "");
      const tMs = Number(o?.obsTime) * 1000;
      const c = metarTempC(o);
      if (!id || !Number.isFinite(tMs) || c === null) continue;
      const list = out.get(id) ?? [];
      list.push({ tMs, c });
      out.set(id, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/** Station coordinates: Map ICAO → { lat, lon, name }. */
export async function fetchStationInfo(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const url = new URL("/api/data/stationinfo", AVIATION_WEATHER);
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("format", "json");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`aviationweather stationinfo HTTP ${res.status}`);
  for (const s of (await res.json()) ?? []) {
    const lat = Number(s?.lat);
    const lon = Number(s?.lon);
    if (s?.icaoId && Number.isFinite(lat) && Number.isFinite(lon)) out.set(String(s.icaoId), { lat, lon, name: String(s.site ?? "") });
  }
  return out;
}
