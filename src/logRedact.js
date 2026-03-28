/**
 * Strip wallet keys and similar secrets from strings and nested structures before logs / disk.
 */

const ETH_PRIV_HEX = /\b0x[a-fA-F0-9]{64}\b/g;
const SENSITIVE_KEY = /^(privateKey|private_key|secret|apiSecret|api_secret|passphrase|mnemonic|seedPhrase|seed|authorization)$/i;

export function redactSecretsInString(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  return s
    .replace(ETH_PRIV_HEX, "0x[REDACTED_PRIVATE_KEY]")
    .replace(/PRIVATE_KEY\s*=\s*\S+/gi, "PRIVATE_KEY=[REDACTED]");
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function sanitizeForLog(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12) return "[MaxDepth]";
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return redactSecretsInString(value);
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "symbol" || t === "function") return `[${t}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecretsInString(value.message ?? "")
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForLog(v, depth + 1, seen));
  }
  if (t !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeForLog(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * One-line safe description for console / PM2 (never pass raw Error objects from HTTP SDKs).
 * @param {unknown} err
 * @returns {string}
 */
export function errorToRedactedLogString(err) {
  if (err === null || err === undefined) return String(err);
  if (typeof err === "string") return redactSecretsInString(err);
  if (err instanceof Error) {
    const msg = redactSecretsInString(err.message ?? "");
    return err.name && err.name !== "Error" ? `${err.name}: ${msg}` : msg;
  }
  if (typeof err === "object" && typeof err.message === "string") {
    return redactSecretsInString(err.message);
  }
  try {
    return redactSecretsInString(JSON.stringify(sanitizeForLog(err)));
  } catch {
    return "[unserializable_error]";
  }
}
