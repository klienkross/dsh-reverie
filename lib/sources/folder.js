/**
 * Folder corpus source: a directory of markdown/text notes.
 *
 * This is the first generic source: any personal archive that is "a pile of
 * files" — an Obsidian vault, a journal directory, exported notes — can be read
 * without a database or a proprietary format. The adapter is deliberately dumb:
 * walk, read, split into sections, hand back normalized documents. Ranking and
 * the model loop stay in the host-free core.
 *
 * @module dsh-reverie/sources/folder
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { estimateTokens, oneLine, truncate } from "../text.js";

/** File extensions read by default. */
const DEFAULT_EXTENSIONS = ["md", "markdown", "txt", "text"];

/** Directory names never walked, plus whatever the entry adds. */
const DEFAULT_EXCLUDE = [".git", ".obsidian", ".trash", ".venv", "node_modules", "__pycache__"];

/** One file larger than this is skipped rather than read into memory. */
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** One document never exceeds this many characters. */
const DEFAULT_MAX_DOC_CHARS = 4_000;

/** Deepest recursion allowed below the root. */
const MAX_DEPTH = 16;

/** A markdown heading line, used as a section boundary. */
const HEADING = /^#{1,6}\s+/;

/**
 * Split one file into line-ranged sections.
 * @param {string} text - file content.
 * @param {number} maxChars - character ceiling per document.
 * @returns {{start: number, end: number, title: string, text: string}[]} 1-based inclusive line ranges.
 */
export function splitSections(text, maxChars) {
  const lines = text.split(/\r?\n/);
  /** @type {{start: number, end: number, title: string, text: string}[]} */
  const sections = [];
  /** @type {{start: number, lines: string[]}} */
  let current = { start: 1, lines: [] };
  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (body !== "") {
      sections.push({
        start: current.start,
        end: current.start + current.lines.length - 1,
        title: oneLine(body, 60),
        text: body,
      });
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (HEADING.test(line) && current.lines.length > 0) {
      flush();
      current = { start: index + 1, lines: [] };
    }
    current.lines.push(line);
  }
  flush();
  if (sections.length === 0) return [];
  // Oversized sections are chunked at paragraph boundaries instead of being
  // silently truncated, so every word of the note stays reachable.
  const bounded = [];
  for (const section of sections) {
    if (section.text.length <= maxChars) {
      bounded.push(section);
      continue;
    }
    const chunks = chunkText(section.text, maxChars);
    let offset = 0;
    for (const chunk of chunks) {
      const start = section.start + section.text.slice(0, offset).split("\n").length - 1;
      const end = start + chunk.split("\n").length - 1;
      bounded.push({ start, end, title: oneLine(chunk, 60), text: chunk });
      offset += chunk.length;
    }
  }
  return bounded;
}

/**
 * Cut one long text into paragraph-aligned chunks.
 * @param {string} text - source text.
 * @param {number} maxChars - character ceiling.
 * @returns {string[]} chunks.
 */
function chunkText(text, maxChars) {
  /** @type {string[]} */
  const chunks = [];
  let buffer = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (buffer !== "" && buffer.length + paragraph.length + 2 > maxChars) {
      chunks.push(buffer.trim());
      buffer = "";
    }
    if (paragraph.length > maxChars) {
      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars));
      }
      continue;
    }
    buffer = buffer === "" ? paragraph : `${buffer}\n\n${paragraph}`;
  }
  if (buffer.trim() !== "") chunks.push(buffer.trim());
  return chunks.filter((chunk) => chunk !== "");
}

/**
 * Normalize one configured folder entry.
 * @param {Record<string, any>} entry - `{id, kind: "folder", root, ...}`.
 * @returns {string | null} the problem, or null when the entry is usable.
 */
export function validateFolderEntry(entry) {
  if (typeof entry.root !== "string" || entry.root.trim() === "") return "folder source needs `root`";
  return null;
}

/**
 * Create a folder source.
 * @param {Record<string, any>} entry - validated configuration entry.
 * @param {{maxDocuments?: number}} [settings] - corpus-wide caps.
 * @returns {any} the source.
 */
export function createFolderSource(entry, settings = {}) {
  const root = path.resolve(entry.root);
  const extensions = new Set(
    (Array.isArray(entry.extensions) && entry.extensions.length > 0 ? entry.extensions : DEFAULT_EXTENSIONS).map((value) =>
      String(value).toLowerCase().replace(/^\./, ""),
    ),
  );
  const exclude = new Set(
    [...DEFAULT_EXCLUDE, ...(Array.isArray(entry.exclude) ? entry.exclude : [])].map((value) => String(value).toLowerCase()),
  );
  const maxFileBytes = Number.isFinite(entry.maxFileBytes) ? Number(entry.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  const maxDocChars = Number.isFinite(entry.maxDocChars) ? Number(entry.maxDocChars) : DEFAULT_MAX_DOC_CHARS;
  const maxDocuments = settings.maxDocuments ?? 5_000;

  /**
   * Walk the tree without following symlinks.
   * @param {string} directory - absolute directory.
   * @param {number} depth - current depth.
   * @param {string[]} out - collected absolute file paths.
   * @returns {Promise<void>} resolves after the walk.
   */
  async function walk(directory, depth, out) {
    if (depth > MAX_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const item of entries) {
      if (item.isSymbolicLink()) continue;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) {
        if (exclude.has(item.name.toLowerCase())) continue;
        await walk(absolute, depth + 1, out);
        continue;
      }
      if (!item.isFile()) continue;
      const extension = path.extname(item.name).slice(1).toLowerCase();
      if (!extensions.has(extension)) continue;
      out.push(absolute);
    }
  }

  /**
   * Read one file and turn it into documents.
   * @param {string} absolute - absolute file path.
   * @param {number} mtime - file modification time.
   * @returns {Promise<{documents: any[], problems: string[]}>} documents with source-local locators.
   */
  async function readFileDocuments(absolute, mtime) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const info = await stat(absolute);
    if (info.size > maxFileBytes) {
      return { documents: [], problems: [`${relative}: skipped (${info.size} bytes > ${maxFileBytes})`] };
    }
    const text = await readFile(absolute, "utf8");
    const sections = splitSections(text, maxDocChars);
    return {
      documents: sections.map((section) => ({
        locator: `${relative}#L${section.start}-L${section.end}`,
        text: section.text,
        title: section.title,
        kind: "note",
        time: mtime,
        group: relative,
        meta: { path: relative },
      })),
      problems: [],
    };
  }

  return {
    id: entry.id,
    kind: "folder",
    describe() {
      return `folder ${root} · ${[...extensions].join("/")}`;
    },

    /**
     * Load every note under the root.
     * @param {{signal?: AbortSignal, limit?: number}} [options] - cancellation and cap.
     * @returns {Promise<{documents: any[], groups: any[], problems: string[]}>} normalized corpus slice.
     */
    async load(options = {}) {
      const problems = [];
      /** @type {string[]} */
      const files = [];
      try {
        await walk(root, 0, files);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
          return { documents: [], groups: [], problems: [`folder ${root} does not exist`] };
        }
        throw error;
      }
      const limit = Math.min(maxDocuments, options.limit ?? maxDocuments);
      const documents = [];
      /** @type {Map<string, {documents: number, firstTime: number, lastTime: number}>} */
      const groups = new Map();
      // Newest files first, so a capped load still reads current material.
      const stated = [];
      for (const absolute of files) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
        try {
          const info = await stat(absolute);
          stated.push({ absolute, mtime: info.mtimeMs });
        } catch (error) {
          problems.push(`${path.relative(root, absolute)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      stated.sort((left, right) => right.mtime - left.mtime);
      for (const file of stated) {
        if (documents.length >= limit) break;
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
        try {
          const result = await readFileDocuments(file.absolute, file.mtime);
          problems.push(...result.problems);
          for (const document of result.documents) {
            if (documents.length >= limit) break;
            documents.push(document);
            const group = groups.get(document.group) ?? { documents: 0, firstTime: document.time, lastTime: document.time };
            group.documents += 1;
            group.lastTime = Math.max(group.lastTime, document.time);
            groups.set(document.group, group);
          }
        } catch (error) {
          problems.push(`${path.relative(root, file.absolute)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return {
        documents,
        groups: [...groups.entries()].map(([name, value]) => ({
          name,
          documents: value.documents,
          firstTime: value.firstTime,
          lastTime: value.lastTime,
        })),
        problems,
      };
    },

    /**
     * Expand one locator back to its file section.
     * @param {string} locator - `relative/path.md#L12-L40`.
     * @returns {Promise<{documents: any[], problems: string[]}>} the section text.
     */
    async read(locator) {
      const match = /^(.+?)#L(\d+)-L(\d+)$/.exec(locator);
      if (!match) throw new Error(`unsupported folder locator: ${locator}`);
      const relative = match[1];
      const start = Number(match[2]);
      const end = Number(match[3]);
      const absolute = path.resolve(root, relative);
      if (!absolute.startsWith(root + path.sep) && absolute !== root) {
        throw new Error(`locator escapes the source root: ${relative}`);
      }
      const text = await readFile(absolute, "utf8");
      const lines = text.split(/\r?\n/);
      const slice = lines.slice(Math.max(0, start - 1), end);
      return {
        documents: [
          {
            locator,
            text: truncate(slice.join("\n"), DEFAULT_MAX_DOC_CHARS * 2),
            title: oneLine(slice.join(" "), 60),
            kind: "note",
            time: null,
            group: relative,
            meta: { path: relative, bytes: estimateTokens(slice.join("\n")) },
          },
        ],
        problems: [],
      };
    },
  };
}
