/**
 * Daily high-temperature bucket markets ("Highest temperature in NYC on October 3?" → "74-75°F", "73°F or below", …).
 *
 * Model: Open-Meteo ensemble members (ECMWF + GFS + ICON) give the distribution of the day's max for the
 * hours still to come; live METAR observations at the resolution station floor that distribution
 * (the high can't go back down) and bias-correct the remaining forecast. Markets resolve on Wunderground
 * whole-degree readings at a named airport station, so buckets are integer-rounded.
 */
import { normCdf } from "./math.js";

const OPEN_METEO_ENSEMBLE = process.env.OPEN_METEO_ENSEMBLE_URL || "https://ensemble-api.open-meteo.com/v1/ensemble";
const AVIATION_WEATHER = process.env.AVIATION_WEATHER_URL || "https://aviationweather.gov";
const ENSEMBLE_MODELS = process.env.WEATHER_ENSEMBLE_MODELS || "ecmwf_ifs025,gfs025,icon_seamless";

/** Known resolution stations (lat/lon). Unknown ICAOs are looked up via aviationweather.gov stationinfo. */
export const STATIONS = {
  KLGA: [40.7769, -73.874], KJFK: [40.6398, -73.7789], KORD: [41.9786, -87.9048], KMDW: [41.7868, -87.7522],
  KATL: [33.6367, -84.4281], KDAL: [32.8471, -96.8518], KDFW: [32.8998, -97.0403], KMIA: [25.7932, -80.2906],
  KSEA: [47.4502, -122.3088], KLAX: [33.9416, -118.4085], KSFO: [37.6213, -122.379], KBOS: [42.3656, -71.0096],
  KDEN: [39.8561, -104.6737], KAUS: [30.1945, -97.6699], KPHX: [33.4342, -112.0116], KIAH: [29.9902, -95.3368],
  KHOU: [29.6454, -95.2789], KMSP: [44.8848, -93.2223], KDCA: [38.8512, -77.0402], KPHL: [39.8744, -75.2424],
  KLAS: [36.084, -115.1537], EGLC: [51.5048, 0.0495], EGLL: [51.47, -0.4543], LFPG: [49.0097, 2.5479],
  NZWN: [-41.3272, 174.8053], CYYZ: [43.6777, -79.6248], RKSI: [37.4602, 126.4407], SAEZ: [-34.8222, -58.5358],
  LTAC: [40.1281, 32.9951], RJTT: [35.5494, 139.7798], EDDM: [48.3538, 11.7861], LEMD: [40.4983, -3.5676],
  WSSS: [1.3644, 103.9915], VHHH: [22.308, 113.9185], YSSY: [-33.9399, 151.1753], SBGR: [-23.4356, -46.4731],
  LIRF: [41.8003, 12.2389], EHAM: [52.3105, 4.7683], OMDB: [25.2532, 55.3657], VIDP: [28.5562, 77.1],
  ZBAA: [40.0801, 116.5846], ZSPD: [31.1443, 121.8083], RCTP: [25.0777, 121.2328]
};

const STATION_NAME_HINTS = [
  [/laguardia/i, "KLGA"], [/o'?hare/i, "KORD"], [/hartsfield/i, "KATL"], [/love field/i, "KDAL"],
  [/dallas\/fort worth|dfw/i, "KDFW"], [/miami international/i, "KMIA"], [/seattle-tacoma|sea-tac/i, "KSEA"],
  [/london city/i, "EGLC"], [/heathrow/i, "EGLL"], [/charles de gaulle/i, "LFPG"], [/wellington/i, "NZWN"],
  [/pearson/i, "CYYZ"], [/incheon/i, "RKSI"], [/ezeiza|pistarini/i, "SAEZ"], [/esenbo/i, "LTAC"]
];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseStation(text) {
  const s = String(text || "");
  const url = /wunderground\.com\/history\/daily\/[^\s"')]*?\/([A-Z0-9]{4})(?=[^A-Za-z0-9]|$)/.exec(s);
  if (url) return url[1];
  for (const [re, icao] of STATION_NAME_HINTS) if (re.test(s)) return icao;
  return null;
}

/** Bucket from "74-75°F", "73°F or below", "84°F or higher", "15°C". Bounds are inclusive integers; null = open. */
export function parseBucket(text) {
  const s = String(text || "").replace(/º/g, "°");
  let m = /(-?\d+)\s*(?:-|–|to)\s*(-?\d+)\s*°\s*([FC])/i.exec(s);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]), unit: m[3].toUpperCase() };
  m = /(-?\d+)\s*°\s*([FC])\s*or\s*(below|lower|less|under)/i.exec(s);
  if (m) return { lo: null, hi: Number(m[1]), unit: m[2].toUpperCase() };
  m = /(-?\d+)\s*°\s*([FC])\s*or\s*(higher|above|more|over)/i.exec(s);
  if (m) return { lo: Number(m[1]), hi: null, unit: m[2].toUpperCase() };
  m = /(-?\d+)\s*°\s*([FC])\b/i.exec(s);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]), unit: m[2].toUpperCase() };
  return null;
}

/** "on October 3" → "YYYY-MM-DD", year taken from the market end date (closest match). */
export function parseTargetDate(text, endMs) {
  const m = new RegExp(String.raw`\b(${MONTHS.join("|")})\s+(\d{1,2})\b`, "i").exec(String(text || ""));
  if (!m || !endMs) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const endYear = new Date(endMs).getUTCFullYear();
  let best = null;
  for (const y of [endYear - 1, endYear, endYear + 1]) {
    const t = Date.UTC(y, month, day);
    if (best === null || Math.abs(t - endMs) < Math.abs(best - endMs)) best = t;
  }
  return new Date(best).toISOString().slice(0, 10);
}

export function parseWeatherMarket(market) {
  const title = `${market.eventTitle} ${market.question}`;
  if (!/highest temperature|high temperature|daily high/i.test(title)) return null;
  const bucket = parseBucket(market.groupItemTitle) ?? parseBucket(market.question);
  const station = parseStation(market.description) ?? parseStation(market.question);
  const date = parseTargetDate(market.question, market.endMs) ?? parseTargetDate(market.eventTitle, market.endMs);
  if (!bucket || !station || !date) return null;
  return { ...bucket, station, date };
}

/** METAR temperature in °C, using the T-group tenths (e.g. T02560178 → 25.6) when present. */
export function metarTempC(obs) {
  const t = /\bT([01])(\d{3})[01]\d{3}\b/.exec(String(obs?.rawOb || ""));
  if (t) return (t[1] === "1" ? -1 : 1) * Number(t[2]) / 10;
  const n = Number(obs?.temp);
  return Number.isFinite(n) ? n : null;
}

const cToUnit = (c, unit) => (unit === "F" ? c * 9 / 5 + 32 : c);

/** Local "YYYY-MM-DDTHH:MM" (Open-Meteo, timezone=auto) → UTC ms. */
const localToUtcMs = (s, offsetSec) => Date.parse(s.length === 16 ? `${s}:00Z` : `${s}Z`) - offsetSec * 1000;
const utcMsToLocalDate = (ms, offsetSec) => new Date(ms + offsetSec * 1000).toISOString().slice(0, 10);

/**
 * Distribution inputs for a station-day.
 * Returns { members: number[] (each member's max over remaining hours, bias-corrected), obsMax, hoursAhead }.
 */
export function buildDayDistribution({ forecast, metars, date, unit, nowMs = Date.now(), maxBias = unit === "F" ? 6 : 3.3 }) {
  const offset = Number(forecast?.utc_offset_seconds) || 0;
  const times = forecast?.hourly?.time ?? [];
  const seriesKeys = Object.keys(forecast?.hourly ?? {}).filter((k) => k.startsWith("temperature_2m"));
  const timeMs = times.map((t) => localToUtcMs(t, offset));
  const dayIdx = times.map((t, i) => (t.slice(0, 10) === date ? i : -1)).filter((i) => i >= 0);
  const remainingIdx = dayIdx.filter((i) => timeMs[i] >= nowMs - 30 * 60_000);

  // Observations on the target local date so far
  let obsMax = -Infinity;
  let latestObs = null;
  for (const o of Array.isArray(metars) ? metars : []) {
    const tMs = Number(o?.obsTime) * 1000;
    const c = metarTempC(o);
    if (!Number.isFinite(tMs) || c === null || tMs > nowMs) continue;
    if (utcMsToLocalDate(tMs, offset) !== date) continue;
    const v = cToUnit(c, unit);
    obsMax = Math.max(obsMax, v);
    if (!latestObs || tMs > latestObs.tMs) latestObs = { tMs, v };
  }

  // Same-day bias: latest observation vs ensemble mean at the nearest forecast hour
  let bias = 0;
  if (latestObs && nowMs - latestObs.tMs < 3 * 3_600_000 && timeMs.length) {
    let near = 0;
    for (let i = 1; i < timeMs.length; i += 1) if (Math.abs(timeMs[i] - latestObs.tMs) < Math.abs(timeMs[near] - latestObs.tMs)) near = i;
    const vals = seriesKeys.map((k) => Number(forecast.hourly[k][near])).filter(Number.isFinite);
    if (vals.length) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      bias = Math.max(-maxBias, Math.min(maxBias, latestObs.v - mean));
    }
  }

  const members = [];
  for (const k of seriesKeys) {
    let mx = -Infinity;
    for (const i of remainingIdx) {
      const v = Number(forecast.hourly[k][i]);
      if (Number.isFinite(v)) mx = Math.max(mx, v);
    }
    if (Number.isFinite(mx)) members.push(mx + bias);
  }

  // Hours from now until mid-afternoon of the target day (rough lead time for extra spread)
  const peakIdx = dayIdx.find((i) => times[i].slice(11, 13) === "15");
  const hoursAhead = peakIdx !== undefined ? Math.max(0, (timeMs[peakIdx] - nowMs) / 3_600_000) : 0;
  return { members, obsMax, hoursAhead, bias, dayHoursLeft: remainingIdx.length };
}

/**
 * P(rounded daily max ∈ [lo, hi]) where daily max = max(obsMax, member + N(0, σ)).
 * Integer rounding: reported n covers [n − 0.5, n + 0.5).
 */
export function bucketProbability({ members, obsMax = -Infinity, sigma, lo, hi }) {
  const upper = hi === null ? Infinity : hi + 0.5;
  const lower = lo === null ? -Infinity : lo - 0.5;
  const pts = members.length ? members : Number.isFinite(obsMax) ? [obsMax] : [];
  if (!pts.length) return null;
  const floor = members.length ? obsMax : -Infinity;
  const cdf = (x, v) => (x === Infinity ? 1 : x === -Infinity ? 0 : x < floor ? 0 : normCdf((x - v) / sigma));
  let p = 0;
  for (const v of pts) p += cdf(upper, v) - cdf(lower, v);
  return Math.max(0, Math.min(1, p / pts.length));
}

export function kernelSigma({ hoursAhead, unit, base = Number(process.env.WEATHER_SIGMA_BASE_F ?? 1.0), perHour = Number(process.env.WEATHER_SIGMA_PER_HOUR_F ?? 0.04) }) {
  const f = Math.min(4, base + perHour * hoursAhead);
  return unit === "F" ? f : f * 5 / 9;
}

export function createWeatherModule(opts = {}) {
  const forecastCache = new Map();
  const metarCache = new Map();
  const coordCache = new Map();

  async function coordsFor(icao) {
    if (STATIONS[icao]) return STATIONS[icao];
    if (coordCache.has(icao)) return coordCache.get(icao);
    const url = new URL("/api/data/stationinfo", AVIATION_WEATHER);
    url.searchParams.set("ids", icao);
    url.searchParams.set("format", "json");
    const res = await fetch(url);
    const data = res.ok ? await res.json() : [];
    const st = Array.isArray(data) ? data[0] : null;
    const c = st && Number.isFinite(Number(st.lat)) ? [Number(st.lat), Number(st.lon)] : null;
    coordCache.set(icao, c);
    return c;
  }

  async function forecastFor(icao, unit) {
    const key = `${icao}:${unit}`;
    const hit = forecastCache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.data;
    const c = await coordsFor(icao);
    if (!c) return null;
    const url = new URL(OPEN_METEO_ENSEMBLE);
    url.searchParams.set("latitude", String(c[0]));
    url.searchParams.set("longitude", String(c[1]));
    url.searchParams.set("hourly", "temperature_2m");
    url.searchParams.set("models", ENSEMBLE_MODELS);
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("past_days", "1");
    url.searchParams.set("forecast_days", "4");
    url.searchParams.set("temperature_unit", unit === "F" ? "fahrenheit" : "celsius");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${icao} error: ${res.status}`);
    const data = await res.json();
    forecastCache.set(key, { data, at: Date.now() });
    return data;
  }

  async function metarsFor(icao) {
    const hit = metarCache.get(icao);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
    const url = new URL("/api/data/metar", AVIATION_WEATHER);
    url.searchParams.set("ids", icao);
    url.searchParams.set("format", "json");
    url.searchParams.set("hours", "36");
    const res = await fetch(url);
    const data = res.ok ? await res.json() : [];
    metarCache.set(icao, { data, at: Date.now() });
    return Array.isArray(data) ? data : [];
  }

  return {
    name: "weather",
    feeCategory: "weather",
    tags: opts.tags ?? ["weather"],
    endWithinMs: (opts.maxDays ?? 4) * 24 * 3_600_000,

    parse(market) {
      return parseWeatherMarket(market);
    },

    async priceAll(items, nowMs = Date.now()) {
      const out = new Map();
      const groups = new Map();
      for (const it of items) {
        const key = `${it.spec.station}|${it.spec.unit}|${it.spec.date}`;
        const list = groups.get(key) ?? [];
        list.push(it);
        groups.set(key, list);
      }
      for (const [key, list] of groups) {
        const [station, unit, date] = key.split("|");
        let forecast;
        let metars;
        try {
          [forecast, metars] = await Promise.all([forecastFor(station, unit), metarsFor(station)]);
        } catch {
          continue;
        }
        if (!forecast) continue;
        const dist = buildDayDistribution({ forecast, metars, date, unit, nowMs });
        if (!dist.members.length && !Number.isFinite(dist.obsMax)) continue;
        const sigma = dist.members.length ? kernelSigma({ hoursAhead: dist.hoursAhead, unit }) : (unit === "F" ? 0.3 : 0.2);
        for (const it of list) {
          const p = bucketProbability({ members: dist.members, obsMax: dist.obsMax, sigma, lo: it.spec.lo, hi: it.spec.hi });
          if (p === null) continue;
          out.set(it.market.id, {
            p,
            meta: {
              station,
              date,
              unit,
              bucket: `${it.spec.lo ?? ""}..${it.spec.hi ?? ""}`,
              obsMax: Number.isFinite(dist.obsMax) ? Number(dist.obsMax.toFixed(1)) : "",
              members: dist.members.length,
              sigma: Number(sigma.toFixed(2)),
              bias: Number(dist.bias.toFixed(2)),
              hoursLeft: dist.dayHoursLeft
            }
          });
        }
      }
      return out;
    }
  };
}
