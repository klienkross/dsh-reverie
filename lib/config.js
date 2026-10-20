/**
 * Plugin-owned runtime configuration.
 *
 * The cordis row config only decides mounting and the system-prompt
 * announcement. Everything an operator tunes per machine (corpus scope,
 * provider/model, budgets, mock/live) lives in `~/.dsh/reverie/config.json`,
 * written atomically by the `reverie_config` tool. That keeps profile YAML
 * stable across plugin upgrades and keeps the file reviewable by a human.
 *
 * @module dsh-reverie/config
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { validateSources } from "./sources/index.js";

/** Default runtime settings; every field is validated on load and on write. */
export const DEFAULTS = Object.freeze({
  /**
   * Corpus sources. Empty means the harness's own session history for the
   * current workspace. Each entry is `{id, kind, ...}` where kind is one of
   * `folder`, `json`, `dsh-sessions`.
   */
  sources: [],
  /** Corpus scope for the default session source: `workspace` or `all`. */
  scope: "workspace",
  /** Include subagent child sessions as corpus. Off by default: they are usually tool chatter. */
  includeSubagents: false,
  /** Newest N persisted sessions considered per run (default session source). */
  maxSessions: 24,
  /** Only sessions created within this many days; 0 disables the cutoff. */
  lookbackDays: 0,
  /** Hard cap on corpus documents per run. */
  maxDocuments: 4000,
  /** Minimum characters in one document before it enters the corpus. */
  minDocumentChars: 24,
  /** Cached corpus lifetime in milliseconds. */
  cacheTtlMs: 600_000,
  /** Provider route; empty means discover the first registered provider. */
  provider: "",
  /** Model id; empty means the provider's first advertised model. */
  model: "",
  /** Reasoning effort for the run, forwarded verbatim when non-empty. */
  reasoningEffort: "",
  /** `mock` never calls a model; `live` spends API budget. */
  mode: "mock",
  /** Model steps per run. */
  maxSteps: 8,
  /** Cumulative input-token ceiling per run (provider usage when reported, estimate otherwise). */
  maxInputTokens: 60_000,
  /** Output-token ceiling per model step. */
  maxOutputTokens: 2_048,
  /** Wall-clock ceiling for one run. */
  timeoutMs: 600_000,
  /** Character ceiling for the private note the run may leave behind. */
  maxNoteChars: 2_000,
  /** Optional persona/identity file merged into the system prompt. */
  persona: "",
  /** Report language: `zh` or `en`. */
  language: "zh",
});

/** Every configuration key, for validation and `reverie_config` listings. */
export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS));

/** Root data directory for the plugin: `$DSH_HOME/reverie`. */
export function reverieRoot() {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), ".dsh");
  return path.join(home, "reverie");
}

/** Absolute path of the runtime configuration file. */
export function configPath() {
  return path.join(reverieRoot(), "config.json");
}

/** Absolute path of the run-artifact root. */
export function runsRoot() {
  return path.join(reverieRoot(), "runs");
}

/**
 * Coerce one raw value into the shape its default declares.
 * @param {string} key - configuration key.
 * @param {unknown} value - candidate value.
 * @returns {{ok: true, value: unknown} | {ok: false, reason: string}} result.
 */
export function coerce(key, value) {
  const fallback = /** @type {Record<string, unknown>} */ (DEFAULTS)[key];
  if (typeof fallback === "boolean") {
    if (typeof value !== "boolean") return { ok: false, reason: "must be a boolean" };
    return { ok: true, value };
  }
  if (typeof fallback === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, reason: "must be a non-negative number" };
    }
    return { ok: true, value: Math.floor(value) };
  }
  if (typeof value !== "string") return { ok: false, reason: "must be a string" };
  if (key === "mode" && value !== "mock" && value !== "live") {
    return { ok: false, reason: "must be `mock` or `live`" };
  }
  if (key === "scope" && value !== "workspace" && value !== "all") {
    return { ok: false, reason: "must be `workspace` or `all`" };
  }
  if (key === "language" && value !== "zh" && value !== "en") {
    return { ok: false, reason: "must be `zh` or `en`" };
  }
  return { ok: true, value };
}

/**
 * Apply a partial update on top of a base configuration.
 * @param {Record<string, unknown>} base - the current settings.
 * @param {Record<string, unknown>} patch - caller-supplied overrides.
 * @returns {{settings: Record<string, unknown>, rejected: {key: string, reason: string}[], problems: string[]}} result.
 */
export function merge(base, patch) {
  /** @type {Record<string, unknown>} */
  const settings = { ...base };
  /** @type {{key: string, reason: string}[]} */
  const rejected = [];
  /** @type {string[]} */
  const problems = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!CONFIG_KEYS.includes(key)) {
      rejected.push({ key, reason: "unknown key" });
      continue;
    }
    if (key === "sources") {
      const validated = validateSources(value);
      settings.sources = validated.sources;
      problems.push(...validated.problems);
      if (!Array.isArray(value)) rejected.push({ key, reason: "must be an array" });
      continue;
    }
    const result = coerce(key, value);
    if (!result.ok) {
      rejected.push({ key, reason: result.reason });
      continue;
    }
    settings[key] = result.value;
  }
  return { settings, rejected, problems };
}

/**
 * Read the runtime settings, filling absent or invalid fields from defaults.
 * @returns {Promise<{settings: Record<string, unknown>, path: string, existed: boolean, problems: string[]}>}
 *   the effective settings plus any per-field problem worth surfacing.
 */
export async function readConfig() {
  const file = configPath();
  const problems = [];
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    return { settings: { ...DEFAULTS }, path: file, existed: false, problems };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Keep the operator's file intact and say so instead of silently resetting it.
    problems.push(`config.json is not valid JSON (${/** @type {Error} */ (error).message}); using defaults`);
    return { settings: { ...DEFAULTS }, path: file, existed: true, problems };
  }
  let settings = { ...DEFAULTS };
  const { settings: merged, rejected, problems: mergeProblems } = merge(settings, parsed);
  settings = merged;
  problems.push(...mergeProblems);
  for (const entry of rejected) problems.push(`ignored ${entry.key}: ${entry.reason}`);
  return { settings, path: file, existed: true, problems };
}

/**
 * Persist settings atomically, creating the plugin root when missing.
 * @param {Record<string, unknown>} settings - complete settings object.
 * @returns {Promise<string>} the file written.
 */
export async function writeConfig(settings) {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, file);
  return file;
}
