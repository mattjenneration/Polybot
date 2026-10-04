/** Local-day helpers on IANA time zones (DST-safe; no fixed UTC offsets). */
const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallClock(ms, tz) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute), s: Number(parts.second) };
}

/** Local wall time minus UTC, in ms, at instant `ms`. */
export function tzOffsetMs(ms, tz) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** "YYYY-MM-DD" local date at instant `ms`. */
export function localDate(ms, tz) {
  const w = wallClock(ms, tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Fractional local hour of day (0..24). */
export function localHour(ms, tz) {
  const w = wallClock(ms, tz);
  return w.h + w.mi / 60 + w.s / 3600;
}

/** UTC ms of local wall time `date` + `hour` in `tz`. */
export function localTimeToMs(date, hour, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + hour * 3_600_000;
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  return guess;
}

/** [startMs, endMs) of a local calendar day. */
export function localDayBounds(date, tz) {
  return { startMs: localTimeToMs(date, 0, tz), endMs: localTimeToMs(addDays(date, 1), 0, tz) };
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Lead bin for a market on local `date`: d3/d2/d1 by calendar days ahead; d0a–d0d on the day itself by hours
 * left (>12, 6–12, 2–6, <2); "post" once the local day is over.
 */
export function leadBinFor(date, tz, nowMs) {
  const { endMs } = localDayBounds(date, tz);
  if (nowMs >= endMs) return "post";
  const dd = daysBetween(localDate(nowMs, tz), date);
  if (dd >= 3) return "d3";
  if (dd === 2) return "d2";
  if (dd === 1) return "d1";
  const hoursLeft = (endMs - nowMs) / 3_600_000;
  if (hoursLeft > 12) return "d0a";
  if (hoursLeft > 6) return "d0b";
  if (hoursLeft > 2) return "d0c";
  return "d0d";
}
