import fs from "node:fs";
import path from "node:path";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const line = formatCsvRow(row);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${header.join(",")}\n${line}\n`, "utf8");
    return;
  }
  fs.appendFileSync(filePath, `${line}\n`, "utf8");
}
