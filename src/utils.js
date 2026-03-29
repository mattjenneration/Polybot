import fs from "node:fs";
import path from "node:path";

export function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

/** CLOB/Gamma prices are usually 0–1; some feeds use 0–100. */
export function normalizeOutcomeProb(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1) return n / 100;
  return n;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatNumber(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(x);
}

export function formatPct(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return `${(x * 100).toFixed(digits)}%`;
}

export function getCandleWindowTiming(windowMinutes) {
  const nowMs = Date.now();
  const windowMs = windowMinutes * 60_000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  const elapsedMs = nowMs - startMs;
  const remainingMs = endMs - nowMs;
  return {
    startMs,
    endMs,
    elapsedMs,
    remainingMs,
    elapsedMinutes: elapsedMs / 60_000,
    remainingMinutes: remainingMs / 60_000
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function formatCsvRow(row) {
  return row
    .map((v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes("\n") || s.includes('"')) {
        return `"${s.replaceAll('"', '""')}"`;
      }
      return s;
    })
    .join(",");
}

export function appendCsvRow(filePath, header, row) {
  ensureDir(path.dirname(filePath));
  const exists = fs.existsSync(filePath);
  const line = formatCsvRow(row);

  if (!exists) {
    fs.writeFileSync(filePath, `${header.join(",")}\n${line}\n`, "utf8");
    return;
  }

  fs.appendFileSync(filePath, `${line}\n`, "utf8");
}

/**
 * Keeps only data lines whose first column is ts_ms >= cutoffMs (unquoted integer),
 * then appends newRow. Rewrites the whole file (rolling window on disk).
 */
export function rewriteRollingCsvByLeadingTimestampMs(filePath, header, newRow, cutoffMs) {
  ensureDir(path.dirname(filePath));
  const headerLine = header.join(",");
  const newLine = formatCsvRow(newRow);
  const kept = [];
  if (fs.existsSync(filePath)) {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length > 0 && lines[0] === headerLine) {
        for (let i = 1; i < lines.length; i += 1) {
          const m = lines[i].match(/^(\d+),/);
          const ts = m ? Number(m[1]) : NaN;
          if (Number.isFinite(ts) && ts >= cutoffMs) kept.push(lines[i]);
        }
      }
    } catch {
      // reset below
    }
  }
  fs.writeFileSync(filePath, `${headerLine}\n${[...kept, newLine].join("\n")}\n`, "utf8");
}
