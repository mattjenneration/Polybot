const ANSI = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", gray: "\x1b[90m", bold: "\x1b[1m" };

function pad(s, w, right = false) {
  const str = String(s);
  const visible = str.replace(/\x1b\[[0-9;]*m/g, "").length;
  if (visible >= w) return str;
  return right ? " ".repeat(w - visible) + str : str + " ".repeat(w - visible);
}

function money(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

function pct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  return `${(x * 100).toFixed(digits)}%`;
}

function colorSigned(text, x, color) {
  if (!color || !Number.isFinite(x) || x === 0) return text;
  return `${x > 0 ? ANSI.green : ANSI.red}${text}${ANSI.reset}`;
}

export function formatLeaderboard(summary, { color = true } = {}) {
  const cols = [
    ["Strategy", 24],
    ["Equity", 10, true],
    ["ROI", 8, true],
    ["Bets", 6, true],
    ["Win%", 7, true],
    ["P&L", 10, true],
    ["Exp P&L", 10, true],
    ["Fees", 8, true],
    ["Ret/$", 7, true],
    ["MaxDD", 7, true],
    ["Status", 26]
  ];
  const header = cols.map(([h, w, r]) => pad(h, w, r)).join(" ");
  const lines = [color ? `${ANSI.bold}${header}${ANSI.reset}` : header];
  for (const s of summary.strategies) {
    const status = s.busted ? "BUSTED" : s.currentVariant ? `→ ${s.currentVariant.slice(2, 28)}` : s.lastReason ?? "";
    const row = [
      s.label,
      money(s.equity),
      colorSigned(pct(s.roi), s.roi, color),
      s.bets,
      pct(s.winRate),
      colorSigned(money(s.pnl), s.pnl, color),
      money(s.expectedPnl),
      money(s.fees),
      colorSigned(pct(s.returnOnStaked), s.returnOnStaked, color),
      pct(s.maxDrawdown),
      color ? `${ANSI.gray}${String(status).slice(0, 26)}${ANSI.reset}` : String(status).slice(0, 26)
    ];
    lines.push(row.map((v, i) => pad(v, cols[i][1], cols[i][2])).join(" "));
  }
  return lines.join("\n");
}

export function formatLearner(summary) {
  const sc = summary.learner.scorecard;
  const fmt = (k) => (sc[k]?.n ? `${k} ${sc[k].logLoss.toFixed(4)}` : `${k} -`);
  const w = summary.learner.weights;
  const weights = Object.entries(w).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
  return [
    `Model log-loss (lower is better, n=${sc.learned?.n ?? 0}): ${fmt("learned")} | ${fmt("fair")} | ${fmt("market")}`,
    `Learned weights: ${weights}`
  ].join("\n");
}

export function formatAdaptive(summary, limit = 5) {
  if (!summary.adaptive.length) return "Adaptive: no shadow bets settled yet";
  const rows = summary.adaptive.slice(0, limit).map((v) =>
    `  ${pad(v.label, 40)} n=${pad(v.n, 5, true)} ret/$=${pad(pct(v.mean, 2), 8, true)} lcb=${pad(pct(v.lcb, 2), 8, true)}`
  );
  return ["Top shadow variants (by lower confidence bound):", ...rows].join("\n");
}
