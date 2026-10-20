/**
 * Read side of the run artifacts.
 *
 * Every path is derived from a validated run id and a fixed file allowlist, so
 * a model-supplied "run" string can never walk out of the run root.
 *
 * @module dsh-reverie/runs
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Run ids the artifact writer produces; anything else is refused. */
const RUN_ID = /^rev-\d{8}-\d{6}-[a-z0-9]{4}$/;

/** Files a report reader may request. */
const FILES = new Set(["run.json", "report.md", "handoff.md", "usage.json", "events.jsonl"]);

/** Day directory shape. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a run id.
 * @param {unknown} value - candidate id.
 * @returns {string} the id when well-formed.
 * @throws {Error} when the id cannot address a run directory.
 */
export function assertRunId(value) {
  const id = String(value ?? "").trim();
  if (!RUN_ID.test(id)) throw new Error(`invalid run id: ${JSON.stringify(value)}`);
  return id;
}

/**
 * Locate a run directory by id.
 * @param {string} root - run root.
 * @param {string} runId - validated run id.
 * @returns {Promise<string>} the absolute directory.
 * @throws {Error} when no day directory holds the run.
 */
export async function findRun(root, runId) {
  let days;
  try {
    days = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT")
      throw new Error(`no runs recorded yet (${root})`);
    throw error;
  }
  for (const entry of days
    .filter((candidate) => candidate.isDirectory() && DAY.test(candidate.name))
    .sort((left, right) => right.name.localeCompare(left.name))) {
    const candidate = path.join(root, entry.name, runId);
    try {
      await readFile(path.join(candidate, "run.json"), "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`run not found: ${runId}`);
}

/**
 * Read one allowlisted artifact of one run.
 * @param {string} root - run root.
 * @param {string} runId - run id.
 * @param {string} name - artifact name.
 * @returns {Promise<{runId: string, name: string, content: string}>} the artifact.
 */
export async function readRunFile(root, runId, name) {
  const id = assertRunId(runId);
  if (!FILES.has(name)) throw new Error(`unsupported run artifact: ${name}`);
  const directory = await findRun(root, id);
  const content = await readFile(path.join(directory, name), "utf8");
  return { runId: id, name, content };
}

/**
 * List recorded runs, newest first.
 * @param {string} root - run root.
 * @param {number} limit - maximum entries.
 * @returns {Promise<{runId: string, day: string, mode: string, stopReason: string, endedAt: string, directory: string}[]>}
 *   run summaries; unreadable runs are skipped.
 */
export async function listRuns(root, limit = 10) {
  /** @type {any[]} */
  const runs = [];
  let days;
  try {
    days = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return runs;
    throw error;
  }
  const ordered = days
    .filter((entry) => entry.isDirectory() && DAY.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const day of ordered) {
    if (runs.length >= limit) break;
    const dayDirectory = path.join(root, day);
    const entries = await readdir(dayDirectory, { withFileTypes: true }).catch(() => []);
    const runDirectories = entries
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
    for (const runId of runDirectories) {
      if (runs.length >= limit) break;
      const directory = path.join(dayDirectory, runId);
      try {
        const meta = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
        runs.push({
          runId,
          day,
          mode: meta.mode ?? "unknown",
          stopReason: meta.stop_reason ?? "unknown",
          endedAt: meta.ended_at ?? "",
          directory,
        });
      } catch {
        continue;
      }
    }
  }
  return runs;
}

/**
 * Read the latest successful private note, if it is still fresh and not a mock.
 * This is the seam a "morning paper" consumer would use; the plugin exposes it
 * through `reverie_report` instead of injecting it into a conversation.
 * @param {string} root - run root.
 * @param {{maxAgeMs?: number, allowMock?: boolean, now?: number}} [options] - freshness rules.
 * @returns {Promise<{runId: string, note: string, endedAt: string, mode: string} | null>} the note or null.
 */
export async function latestNote(root, options = {}) {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? 24 * 3_600_000;
  const runs = await listRuns(root, 20);
  for (const run of runs) {
    if (run.mode === "mock" && !options.allowMock) continue;
    if (run.stopReason !== "model-ended" && run.stopReason !== "mock-ended") continue;
    const ended = Date.parse(run.endedAt);
    if (Number.isFinite(ended) && now - ended > maxAge) continue;
    try {
      const { content } = await readRunFile(root, run.runId, "handoff.md");
      return { runId: run.runId, note: content, endedAt: run.endedAt, mode: run.mode };
    } catch {
      continue;
    }
  }
  return null;
}
