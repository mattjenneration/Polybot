/**
 * Open-Meteo: deterministic multi-model forecasts, ensembles, and "previous runs" (what each model forecast
 * 1–3 days earlier — the history the skill tracker learns per-station bias and error from).
 * The free API is for non-commercial use; set OPEN_METEO_API_KEY to use the customer endpoints.
 */
const KEY = (process.env.OPEN_METEO_API_KEY || "").trim();
const host = (sub) => (KEY ? `https://customer-${sub}.open-meteo.com` : `https://${sub}.open-meteo.com`);
const URLS = {
  forecast: process.env.OPEN_METEO_FORECAST_URL || `${host("api")}/v1/forecast`,
  ensemble: process.env.OPEN_METEO_ENSEMBLE_URL || `${host("ensemble-api")}/v1/ensemble`,
  previous: process.env.OPEN_METEO_PREVIOUS_RUNS_URL || `${host("previous-runs-api")}/v1/forecast`
};

async function getJson(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  if (KEY) url.searchParams.set("apikey", KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) throw new Error(`Open-Meteo ${url.hostname} HTTP ${res.status}: ${body?.reason ?? "error"}`);
  return body;
}

const unitParam = (unit) => (unit === "F" ? "fahrenheit" : "celsius");
const clean = (arr) => (Array.isArray(arr) ? arr.map((v) => (v === null || v === undefined ? null : Number(v))) : []);

/** Drop all-null series and exact duplicates (regional models fall back to a global one outside their domain). */
export function dedupeSeries(series) {
  const out = {};
  const seen = new Set();
  for (const [name, values] of Object.entries(series)) {
    if (!values.some((v) => v !== null)) continue;
    const sig = values.map((v) => (v === null ? "n" : v.toFixed(1))).join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out[name] = values;
  }
  return out;
}

/** Hourly temperature from each deterministic model: { tz, times: ms[], models: { name: values[] } }. */
export async function fetchModelForecast({ lat, lon, unit, models, pastDays = 1, forecastDays = 4 }) {
  const d = await getJson(URLS.forecast, {
    latitude: lat, longitude: lon, hourly: "temperature_2m", models: models.join(","), timezone: "auto",
    timeformat: "unixtime", past_days: pastDays, forecast_days: forecastDays, temperature_unit: unitParam(unit)
  });
  const h = d.hourly ?? {};
  const series = {};
  for (const m of models) {
    const v = h[`temperature_2m_${m}`] ?? (models.length === 1 ? h.temperature_2m : undefined);
    if (v) series[m] = clean(v);
  }
  return { tz: d.timezone, times: (h.time ?? []).map((s) => s * 1000), models: dedupeSeries(series), fetchedAt: Date.now() };
}

/** Ensemble members: { tz, times, members: values[][], groups: modelName[] }. */
export async function fetchEnsembleForecast({ lat, lon, unit, models, forecastDays = 4 }) {
  const d = await getJson(URLS.ensemble, {
    latitude: lat, longitude: lon, hourly: "temperature_2m", models: models.join(","), timezone: "auto",
    timeformat: "unixtime", past_days: 1, forecast_days: forecastDays, temperature_unit: unitParam(unit)
  });
  const h = d.hourly ?? {};
  const members = [];
  const groups = [];
  for (const [k, v] of Object.entries(h)) {
    if (!k.startsWith("temperature_2m")) continue;
    const vals = clean(v);
    if (!vals.some((x) => x !== null)) continue;
    members.push(vals);
    groups.push(k.replace(/^temperature_2m_?/, "").replace(/member\d+_?/, "") || "ensemble");
  }
  return { tz: d.timezone, times: (h.time ?? []).map((s) => s * 1000), members, groups, fetchedAt: Date.now() };
}

/**
 * Archived forecasts at fixed leads: series[model][lead] = hourly values, where lead 0 is the same-day run
 * and lead N the run from N days before. Dates are local "YYYY-MM-DD".
 */
export async function fetchPreviousRuns({ lat, lon, unit, models, leads = [0, 1, 2, 3], startDate, endDate }) {
  const vars = leads.map((l) => (l === 0 ? "temperature_2m" : `temperature_2m_previous_day${l}`));
  const d = await getJson(URLS.previous, {
    latitude: lat, longitude: lon, hourly: vars.join(","), models: models.join(","), timezone: "auto",
    timeformat: "unixtime", start_date: startDate, end_date: endDate, temperature_unit: unitParam(unit)
  });
  const h = d.hourly ?? {};
  const series = {};
  for (const m of models) {
    for (const [i, lead] of leads.entries()) {
      const v = h[`${vars[i]}_${m}`] ?? (models.length === 1 ? h[vars[i]] : undefined);
      if (!v) continue;
      const vals = clean(v);
      if (!vals.some((x) => x !== null)) continue;
      (series[m] ??= {})[lead] = vals;
    }
  }
  return { tz: d.timezone, times: (h.time ?? []).map((s) => s * 1000), series };
}

/** Timezone for a coordinate (one cheap call, cached by the station registry). */
export async function fetchTimezone({ lat, lon }) {
  const d = await getJson(URLS.forecast, { latitude: lat, longitude: lon, daily: "temperature_2m_max", timezone: "auto", forecast_days: 1 });
  return d.timezone;
}
