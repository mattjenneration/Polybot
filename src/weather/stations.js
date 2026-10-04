/** Resolution stations: coordinates (aviationweather.gov) and IANA time zone (Open-Meteo), cached on disk. */
import fs from "node:fs";
import { fetchStationInfo } from "./sources/metar.js";
import { fetchTimezone } from "./sources/openMeteo.js";
import { HKO_STATION } from "./sources/hko.js";

export function createStationRegistry({ file }) {
  let stations = {};
  try {
    if (file && fs.existsSync(file)) stations = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    stations = {};
  }
  stations.HKO = { ...HKO_STATION };

  function save() {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify(stations, null, 1));
    } catch {
      // cache only
    }
  }

  /** Fill in any stations missing coordinates or a time zone (at most `maxTz` zone lookups per call). */
  async function ensure(ids, { maxTz = 80 } = {}) {
    const missing = ids.filter((id) => !stations[id]?.lat);
    if (missing.length) {
      const info = await fetchStationInfo(missing);
      for (const [id, s] of info) stations[id] = { id, ...stations[id], ...s };
    }
    let lookups = 0;
    for (const id of ids) {
      const s = stations[id];
      if (!s?.lat || s.tz || lookups >= maxTz) continue;
      lookups += 1;
      s.tz = await fetchTimezone({ lat: s.lat, lon: s.lon });
    }
    if (missing.length || lookups) save();
  }

  /** Record the market unit for a station (used by the backfill CLI). */
  function setUnit(id, unit) {
    if (stations[id] && stations[id].unit !== unit) {
      stations[id].unit = unit;
      save();
    }
  }

  return { ensure, setUnit, get: (id) => (stations[id]?.lat && stations[id]?.tz ? stations[id] : null), all: () => stations };
}
