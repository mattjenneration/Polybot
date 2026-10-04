/** Weather trader configuration (WEATHER_* env vars; see .env.example). */
function num(name, def, min = -Infinity, max = Infinity) {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? def : Number(raw);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : def));
}
function list(name, def) {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.split(",").map((s) => s.trim()).filter(Boolean) : def;
}
function bool(name, def) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? def : raw.toLowerCase() === "true";
}

export const WCFG = {
  logDir: process.env.WEATHER_LOG_DIR || "./logs/weather",
  tags: list("WEATHER_TAGS", ["daily-temperature"]),
  kinds: list("WEATHER_KINDS", ["high", "low"]),
  // Empty = every city Polymarket lists. Otherwise names as they appear in titles ("NYC", "London", …).
  cities: list("WEATHER_CITIES", []),
  // Hourly per-event JSONL snapshots (model, market, approaches) under <logDir>/snapshots for offline analysis.
  snapshots: bool("WEATHER_RECORD_SNAPSHOTS", true),

  loop: {
    tickSec: num("WEATHER_TICK_SECONDS", 30, 5, 600),
    discoverSec: num("WEATHER_DISCOVER_SECONDS", 180, 30, 3600),
    metarSec: num("WEATHER_METAR_SECONDS", 300, 60, 3600),
    forecastMin: num("WEATHER_FORECAST_MINUTES", 60, 15, 720),
    ensembleMin: num("WEATHER_ENSEMBLE_MINUTES", 180, 30, 1440),
    bookMaxAgeSec: num("WEATHER_BOOK_MAX_AGE_SECONDS", 180, 30, 1800),
    snapshotMin: num("WEATHER_SNAPSHOT_MINUTES", 60, 10, 720),
    resolutionCheckMin: num("WEATHER_RESOLUTION_CHECK_MINUTES", 10, 2, 120)
  },

  // Deterministic models (Open-Meteo ids). Regional models that fall back to a global one are de-duplicated.
  models: list("WEATHER_MODELS", [
    "ecmwf_ifs025", "ecmwf_aifs025_single", "gfs_seamless", "icon_seamless", "gem_seamless", "jma_seamless",
    "meteofrance_seamless", "ukmo_seamless", "cma_grapes_global", "ncep_nbm_conus", "knmi_seamless", "metno_seamless"
  ]),
  ensembleModels: list("WEATHER_ENSEMBLE_MODELS", ["ecmwf_ifs025", "gfs025", "icon_seamless"]),

  sim: {
    bankrollUsd: num("WEATHER_BANKROLL_USD", 1000, 10, 1e9),
    strategies: list("WEATHER_STRATEGIES", ["all"]),
    // Risk caps for visible strategies, as a fraction of equity.
    maxEventExposurePct: num("WEATHER_MAX_EVENT_EXPOSURE_PCT", 0.06, 0.001, 1),
    maxOpenExposurePct: num("WEATHER_MAX_OPEN_EXPOSURE_PCT", 0.6, 0.01, 1),
    shadowStakeUsd: num("WEATHER_SHADOW_STAKE_USD", 1, 0.1, 100)
  },

  learning: {
    // Learning mode: shadow variants explore, and every learner (forecast skill, model/market blend, timing,
    // cities, maker fill rates) updates from each settled event. Off = learned parameters are frozen.
    enabled: bool("WEATHER_LEARNING_MODE", true),
    backfillDays: num("WEATHER_BACKFILL_DAYS", 45, 0, 365),
    autoBackfill: bool("WEATHER_AUTO_BACKFILL", true),
    // A variant/city needs this many settled events (decay-weighted) before its record counts.
    minEvents: num("WEATHER_MIN_EVENTS", 15, 1, 1000),
    lcbZ: num("WEATHER_LCB_Z", 1.0, 0, 5),
    calibratorLr: num("WEATHER_CALIBRATOR_LR", 0.05, 0.0001, 1)
  }
};

export const LEAD_BINS = ["d3", "d2", "d1", "d0a", "d0b", "d0c", "d0d", "post"];
