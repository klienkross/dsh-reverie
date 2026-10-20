/**
 * Small text helpers shared by the corpus, search, prompt and artifact layers.
 * Nothing here touches the host: every function is pure.
 */

/** Rough characters-per-token ratio used when a provider reports no usage. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate tokens for budgeting when the provider reports no usage yet.
 * @param {string} text - model-visible text.
 * @returns {number} a conservative, provider-independent estimate.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN);
}

/**
 * Join the text and reasoning parts of content blocks.
 * @param {readonly {type?: string, text?: string}[] | undefined} content - blocks.
 * @returns {string} concatenated text.
 */
export function blocksText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Flatten text findings of one persisted session event.
 *
 * Only the surface events Reverie treats as corpus are supported; anything
 * else returns an empty string so a caller can skip it.
 * @param {any} event - a `SessionEvent` from `ctx.sessionQuery`.
 * @returns {string} extracted plain text.
 */
export function eventText(event) {
  const data = event?.data;
  if (!data) return "";
  switch (event.type) {
    case "user/message":
      return blocksText(data.content);
    case "assistant/message":
      return blocksText(data.message?.content);
    case "tool/result":
      return blocksText(data.message?.content ?? data.content);
    default:
      return "";
  }
}

/**
 * Normalize whitespace and clamp a string to one line.
 * @param {string} text - raw text.
 * @param {number} max - character bound.
 * @returns {string} one-line text.
 */
export function oneLine(text, max = 160) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Clamp a string to a character bound, marking the cut.
 * @param {string} text - raw text.
 * @param {number} max - character bound.
 * @returns {string} possibly truncated text.
 */
export function truncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Format one epoch-millisecond timestamp in UTC for log lines.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} `YYYY-MM-DDTHH:MM:SSZ`.
 */
export function isoTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Format one epoch-millisecond timestamp as a local day key.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} `YYYY-MM-DD` in the host's local time zone.
 */
export function dayKey(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "1970-01-01";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whether two absolute working directories name the same place.
 * @param {string | undefined} left - first directory.
 * @param {string | undefined} right - second directory.
 * @returns {boolean} true when both resolve to the same path.
 */
export function sameDirectory(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left === "" || right === "") return false;
  const normalize = (value) => {
    const trimmed = value.replace(/[\\/]+$/, "");
    return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(left) === normalize(right);
}

/**
 * Hard bound on an arbitrary integer argument.
 * @param {unknown} value - model-supplied value.
 * @param {number} fallback - value used when absent or invalid.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the clamped integer.
 */
export function clampInt(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
