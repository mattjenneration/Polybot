import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Raw-event recorder: one JSON event per line, one file per UTC day
 * (e.g. logs/recordings/2026-09-30.jsonl). These files are the input for backtests.
 */
export function createRecorder(dir, { flushMs = 2000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let buffer = [];
  let currentFile = null;

  function fileFor(ts) {
    return path.join(dir, `${new Date(ts).toISOString().slice(0, 10)}.jsonl`);
  }

  function flush() {
    if (!buffer.length) return;
    const byFile = new Map();
    for (const [file, line] of buffer) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(line);
    }
    buffer = [];
    for (const [file, lines] of byFile) {
      try {
        fs.appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
      } catch (err) {
        console.error(`[recorder] write failed: ${err.message}`);
      }
    }
  }

  const timer = setInterval(flush, flushMs);
  timer.unref?.();

  return {
    write(event) {
      const ts = event.type === "cl" ? event.rx ?? event.ts : event.ts;
      currentFile = fileFor(ts);
      buffer.push([currentFile, JSON.stringify(event)]);
    },
    flush,
    close() {
      clearInterval(timer);
      flush();
    }
  };
}

export function listRecordingFiles(dir, { from = null, to = null } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => (!from || f.slice(0, 10) >= from) && (!to || f.slice(0, 10) <= to))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Stream events from recording files in order. Malformed lines (e.g. a torn final write) are skipped. */
export async function* readEvents(files) {
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip
      }
    }
  }
}

/** Clock value used to order an event during replay (local receive time where available). */
export function eventClock(e) {
  if (e.type === "cl") return e.rx ?? e.ts;
  return e.ts;
}
