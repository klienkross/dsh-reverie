/**
 * JSON / JSONL corpus source.
 *
 * Most personal exports — journal lines, a read-later queue, a bookmarks dump —
 * are "an array of records" or "one JSON object per line". The adapter flattens
 * one level: a root array is the entry list, an object contributes one group
 * per array-valued key, and a single object is one entry.
 *
 * @module dsh-reverie/sources/json
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { oneLine, truncate } from "../text.js";

/** Field names tried, in order, when the entry config names no text field. */
const DEFAULT_TEXT_FIELDS = ["text", "content", "note", "body", "summary", "excerpt"];

/** One document never exceeds this many characters. */
const DEFAULT_MAX_DOC_CHARS = 4_000;

/**
 * Validate one configured JSON entry.
 * @param {Record<string, any>} entry - `{id, kind: "json", path, ...}`.
 * @returns {string | null} the problem, or null when usable.
 */
export function validateJsonEntry(entry) {
  if (typeof entry.path !== "string" || entry.path.trim() === "") return "json source needs `path`";
  return null;
}

/**
 * Pick the corpus text out of one record.
 * @param {unknown} record - one parsed record.
 * @param {string[]} textFields - candidate field names.
 * @returns {string} extracted text, or "" when nothing usable was found.
 */
function recordText(record, textFields) {
  if (typeof record === "string") return record;
  if (record === null || typeof record !== "object") return "";
  for (const field of textFields) {
    const value = /** @type {Record<string, unknown>} */ (record)[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  try {
    return JSON.stringify(record);
  } catch {
    return "";
  }
}

/**
 * Normalize a time field to epoch milliseconds.
 * @param {unknown} value - number, ISO string, or absent.
 * @returns {number | null} epoch milliseconds.
 */
function recordTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Flatten a parsed JSON value into records.
 * @param {unknown} parsed - parsed document.
 * @returns {{group: string, index: number, record: unknown}[]} records.
 */
export function flattenRecords(parsed) {
  if (Array.isArray(parsed)) return parsed.map((record, index) => ({ group: "", index, record }));
  if (parsed !== null && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    const arrayKeys = keys.filter((key) => Array.isArray(/** @type {Record<string, unknown>} */ (parsed)[key]));
    if (arrayKeys.length > 0) {
      const out = [];
      for (const key of arrayKeys) {
        const list = /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (parsed)[key]);
        list.forEach((record, index) => out.push({ group: key, index, record }));
      }
      return out;
    }
    return [{ group: "", index: 0, record: parsed }];
  }
  return [];
}

/**
 * Create a JSON/JSONL source.
 * @param {Record<string, any>} entry - validated configuration entry.
 * @param {{maxDocuments?: number}} [settings] - corpus-wide caps.
 * @returns {any} the source.
 */
export function createJsonSource(entry, settings = {}) {
  const file = path.resolve(entry.path);
  const extensions = path.extname(file).toLowerCase();
  const textFields =
    Array.isArray(entry.textFields) && entry.textFields.length > 0 ? entry.textFields.map(String) : DEFAULT_TEXT_FIELDS;
  const maxDocChars = Number.isFinite(entry.maxDocChars) ? Number(entry.maxDocChars) : DEFAULT_MAX_DOC_CHARS;
  const maxDocuments = settings.maxDocuments ?? 5_000;

  /**
   * Read and parse the configured file.
   * @returns {Promise<{group: string, index: number, record: unknown}[]>} flattened records.
   */
  async function readRecords() {
    const text = await readFile(file, "utf8");
    if (extensions === ".jsonl" || extensions === ".ndjson") {
      /** @type {{group: string, index: number, record: unknown}[]} */
      const records = [];
      let index = 0;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
          records.push({ group: "", index, record: JSON.parse(line) });
        } catch {
          // A malformed line is skipped: one bad export line must not hide the
          // thousands of valid ones around it.
        }
        index += 1;
      }
      return records;
    }
    return flattenRecords(JSON.parse(text));
  }

  return {
    id: entry.id,
    kind: "json",
    describe() {
      return `json ${file}`;
    },

    /**
     * Load every record as one document.
     * @param {{signal?: AbortSignal, limit?: number}} [options] - cancellation and cap.
     * @returns {Promise<{documents: any[], groups: any[], problems: string[]}>} normalized corpus slice.
     */
    async load(options = {}) {
      const limit = Math.min(maxDocuments, options.limit ?? maxDocuments);
      let records;
      try {
        records = await readRecords();
      } catch (error) {
        return {
          documents: [],
          groups: [],
          problems: [`${file}: ${error instanceof Error ? error.message : String(error)}`],
        };
      }
      const documents = [];
      const groups = new Map();
      for (const item of records) {
        if (documents.length >= limit) break;
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
        const record = item.record;
        const text = truncate(recordText(record, textFields).trim(), maxDocChars);
        if (text.length === 0) continue;
        const time = recordTime(
          record !== null && typeof record === "object"
            ? /** @type {Record<string, unknown>} */ (record)[entry.timeField ?? "time"] ?? /** @type {Record<string, unknown>} */ (record).date
            : null,
        );
        const title =
          record !== null && typeof record === "object" && typeof /** @type {Record<string, unknown>} */ (record)[entry.titleField ?? "title"] === "string"
            ? String(/** @type {Record<string, unknown>} */ (record)[entry.titleField ?? "title"])
            : oneLine(text, 60);
        const group = item.group === "" ? path.basename(file) : item.group;
        documents.push({
          locator: `${group}#${item.index}`,
          text,
          title,
          kind: "row",
          time,
          group,
          meta: { file: path.basename(file) },
        });
        const bucket = groups.get(group) ?? { documents: 0, firstTime: time, lastTime: time };
        bucket.documents += 1;
        if (time !== null) {
          bucket.firstTime = bucket.firstTime === null ? time : Math.min(bucket.firstTime, time);
          bucket.lastTime = bucket.lastTime === null ? time : Math.max(bucket.lastTime, time);
        }
        groups.set(group, bucket);
      }
      return {
        documents,
        groups: [...groups.entries()].map(([name, value]) => ({
          name,
          documents: value.documents,
          firstTime: value.firstTime,
          lastTime: value.lastTime,
        })),
        problems: [],
      };
    },

    /**
     * Expand one record locator.
     * @param {string} locator - `group#index`.
     * @returns {Promise<{documents: any[], problems: string[]}>} the record text.
     */
    async read(locator) {
      const match = /^(.*)#(\d+)$/.exec(locator);
      if (!match) throw new Error(`unsupported json locator: ${locator}`);
      const group = match[1] === path.basename(file) ? "" : match[1];
      const index = Number(match[2]);
      const records = await readRecords();
      const found = records.find((item) => item.group === group && item.index === index);
      if (!found) throw new Error(`locator not found: ${locator}`);
      const text = truncate(recordText(found.record, textFields).trim(), maxDocChars);
      return {
        documents: [{ locator, text, title: oneLine(text, 60), kind: "row", time: null, group: locator, meta: {} }],
        problems: [],
      };
    },
  };
}
