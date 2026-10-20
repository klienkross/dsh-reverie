/**
 * Run artifacts: the only thing a Reverie trip leaves behind.
 *
 * Layout under `$DSH_HOME/reverie/runs/<YYYY-MM-DD>/<run-id>/`:
 *   run.json      machine-readable metadata (mode, scope, budget, usage, stop reason)
 *   report.md     human-readable trip report
 *   handoff.md    the bounded private note, explicitly model-generated
 *   events.jsonl  full step/tool/settlement trail (one JSON object per line)
 *   usage.json    token accounting, separate from the narrative
 *
 * A run never writes anywhere else; in particular it never appends to a
 * session, a memory store, or the corpus it read.
 *
 * @module dsh-reverie/artifacts
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Incremented when the artifact schema changes shape. */
export const SCHEMA_VERSION = 1;

/** Prefix every run id carries, so a directory is recognizable on sight. */
const RUN_PREFIX = "rev";

/**
 * Build a sortable run id.
 * @param {number} at - epoch milliseconds.
 * @param {string} suffix - short random suffix.
 * @returns {string} `rev-YYYYMMDD-HHMMSS-xxxx`.
 */
export function runId(at, suffix) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${RUN_PREFIX}-${stamp}-${suffix}`;
}

/**
 * Create a short random suffix without importing a crypto dependency.
 * @returns {string} four base36 characters.
 */
export function randomSuffix() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/**
 * Render the human-readable report.
 * @param {{meta: any, note: string, evidence: any[], language: "zh" | "en"}} options - report inputs.
 * @returns {string} markdown.
 */
export function renderReport(options) {
  const { meta, note, evidence } = options;
  const english = options.language === "en";
  const title = english ? "# Reverie report" : "# Reverie 报告";
  const lines = [
    title,
    "",
    english ? `- run: \`${meta.run_id}\`` : `- run：\`${meta.run_id}\``,
    english ? `- mode: **${meta.mode}**` : `- 模式：**${meta.mode}**`,
    english
      ? `- started: ${meta.started_at} · ended: ${meta.ended_at}`
      : `- 开始：${meta.started_at} · 结束：${meta.ended_at}`,
    english ? `- stop reason: \`${meta.stop_reason}\`` : `- 结束原因：\`${meta.stop_reason}\``,
    english
      ? `- corpus: ${meta.corpus.documents} documents from ${meta.corpus.sources.length} source(s) — ${meta.corpus.sources.map((source) => `${source.id} (${source.kind}, ${source.documents})`).join(", ")}`
      : `- 语料：${meta.corpus.sources.map((source) => `${source.id}（${source.kind}，${source.documents} 条）`).join("、")} 共 ${meta.corpus.documents} 条`,
    meta.mode === "live"
      ? english
        ? `- route: \`${meta.provider}/${meta.model}\``
        : `- 线路：\`${meta.provider}/${meta.model}\``
      : english
        ? "- route: none (mock run, no model call)"
        : "- 线路：无（mock 运行，未调用模型）",
    english
      ? `- usage: ${meta.usage.input} input / ${meta.usage.output} output tokens over ${meta.usage.steps} step(s)`
      : `- 用量：${meta.usage.steps} 个步骤，输入 ${meta.usage.input} / 输出 ${meta.usage.output} tokens`,
    "",
    "---",
    "",
    note,
    "",
  ];
  if (evidence.length > 0) {
    lines.push(english ? "## Evidence index" : "## 证据索引", "");
    for (const item of evidence) {
      lines.push(`- \`${item.locator}\` ${item.time} — ${item.snippet}`);
    }
    lines.push("");
  }
  lines.push(
    english
      ? "> Model-generated material, not an authoritative memory. Read the locators before believing a claim."
      : "> 模型生成材料，不是权威记忆。相信任何结论之前，先按 locator 展开原文。",
    "",
  );
  return lines.join("\n");
}

/**
 * Render the bounded private note file.
 * @param {{note: string, runId: string, generatedAt: string, language: "zh" | "en", mode: string}} options - note inputs.
 * @returns {string} markdown.
 */
export function renderHandoff(options) {
  const header =
    options.language === "en"
      ? "# REVERIE / PRIVATE NOTE\n\nModel-generated, unverified. Ignore it, disagree with it, or follow a locator back into the history. It is not a task.\n"
      : "# REVERIE / 私人纸条\n\n模型生成，未独立验证。可以忽略、可以不同意，也可以顺着 locator 回到原文。它不是待办。\n";
  return `${header}\n_run: \`${options.runId}\` · mode: \`${options.mode}\` · ${options.generatedAt}_\n\n${options.note}\n`;
}

/**
 * Write one complete run directory and update the latest pointer.
 * @param {{root: string, meta: any, note: string, evidence: any[], events: any[], language: "zh" | "en"}} options - run payload.
 * @returns {Promise<{directory: string, runId: string, reportPath: string}>} written locations.
 */
export async function writeRun(options) {
  const day = options.meta.day;
  const directory = path.join(options.root, day, options.meta.run_id);
  await mkdir(directory, { recursive: true });
  const report = renderReport({
    meta: options.meta,
    note: options.note,
    evidence: options.evidence,
    language: options.language,
  });
  const handoff = renderHandoff({
    note: options.note,
    runId: options.meta.run_id,
    generatedAt: options.meta.ended_at,
    language: options.language,
    mode: options.meta.mode,
  });
  const files = {
    "run.json": `${JSON.stringify({ schema_version: SCHEMA_VERSION, ...options.meta }, null, 2)}\n`,
    "report.md": report,
    "handoff.md": handoff,
    "usage.json": `${JSON.stringify(options.meta.usage, null, 2)}\n`,
    "events.jsonl": `${options.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content, "utf8");
  }
  await writeFile(
    path.join(options.root, "latest.json"),
    `${JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        run_id: options.meta.run_id,
        day,
        at: options.meta.ended_at,
        mode: options.meta.mode,
        stop_reason: options.meta.stop_reason,
        directory,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { directory, runId: options.meta.run_id, reportPath: path.join(directory, "report.md") };
}

/**
 * Copy a finished run directory to a stable location; used by tests.
 * @param {string} from - source directory.
 * @param {string} to - destination directory.
 * @returns {Promise<void>} resolves after the rename.
 */
export async function moveDirectory(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
}

/**
 * Read one UTF-8 artifact with a hard size bound.
 * @param {string} file - absolute path.
 * @param {number} maxBytes - byte ceiling.
 * @returns {Promise<string>} file content.
 */
export async function readArtifact(file, maxBytes = 512 * 1024) {
  const content = await readFile(file, "utf8");
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    return `${content.slice(0, maxBytes)}\n… (truncated at ${maxBytes} bytes)`;
  }
  return content;
}

/**
 * List run day directories, newest first.
 * @param {string} root - run root.
 * @returns {Promise<string[]>} day directory names.
 */
export async function listDays(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return [];
    throw error;
  }
}
