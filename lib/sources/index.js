/**
 * Corpus source registry.
 *
 * A source is anything that can hand the core a flat list of text documents
 * with stable locators: a folder of notes, a JSON/JSONL export, the harness's
 * own session history. Adding a store type means writing one `create*Source`
 * function and listing its kind here — the ranking, the model loop and the
 * artifact writer never learn where the text came from.
 *
 * @module dsh-reverie/sources
 */

import { createDshSource } from "./dsh.js";
import { createFolderSource, validateFolderEntry } from "./folder.js";
import { createJsonSource, validateJsonEntry } from "./json.js";

/** Source kinds this build can mount. */
export const SOURCE_KINDS = Object.freeze(["folder", "json", "dsh-sessions"]);

/** Source ids are also locator prefixes, so keep them path-safe. */
const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * The default corpus when no `sources` list is configured: the harness's own
 * session history, scoped to the current workspace.
 * @param {Record<string, any>} settings - effective runtime settings.
 * @returns {Record<string, any>[]} one source entry.
 */
export function defaultSources(settings) {
  return [
    {
      id: "dsh",
      kind: "dsh-sessions",
      scope: settings.scope,
      includeSubagents: settings.includeSubagents,
      maxSessions: settings.maxSessions,
      lookbackDays: settings.lookbackDays,
      minDocumentChars: settings.minDocumentChars,
    },
  ];
}

/**
 * Validate one configured source entry.
 * @param {unknown} entry - candidate entry.
 * @returns {string | null} the problem, or null when usable.
 */
export function validateSourceEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "source entry must be an object";
  const candidate = /** @type {Record<string, any>} */ (entry);
  if (typeof candidate.id !== "string" || !SOURCE_ID.test(candidate.id)) {
    return "source id must match [a-z0-9][a-z0-9_-]{0,31}";
  }
  if (typeof candidate.kind !== "string" || !SOURCE_KINDS.includes(candidate.kind)) {
    return `source kind must be one of ${SOURCE_KINDS.join(", ")}`;
  }
  if (candidate.kind === "folder") return validateFolderEntry(candidate);
  if (candidate.kind === "json") return validateJsonEntry(candidate);
  return null;
}

/**
 * Validate a whole `sources` setting.
 * @param {unknown} value - candidate array.
 * @returns {{sources: Record<string, any>[], problems: string[]}} valid entries and problems.
 */
export function validateSources(value) {
  const problems = [];
  if (!Array.isArray(value)) return { sources: [], problems: ["sources must be an array"] };
  const seen = new Set();
  const sources = [];
  for (const entry of value) {
    const problem = validateSourceEntry(entry);
    if (problem !== null) {
      problems.push(`ignored source: ${problem}`);
      continue;
    }
    if (seen.has(entry.id)) {
      problems.push(`ignored source: duplicate id ${entry.id}`);
      continue;
    }
    seen.add(entry.id);
    sources.push(entry);
  }
  return { sources, problems };
}

/**
 * Mount the configured sources.
 * @param {Record<string, any>} settings - effective runtime settings.
 * @param {{sessionQuery?: any, cwd: string, now?: number}} env - host bindings for non-file sources.
 * @returns {{sources: any[], problems: string[]}} mounted sources.
 */
export function createSources(settings, env) {
  const configured = Array.isArray(settings.sources) && settings.sources.length > 0 ? settings.sources : defaultSources(settings);
  const { sources: entries, problems } = validateSources(configured);
  const mounted = [];
  for (const entry of entries) {
    try {
      if (entry.kind === "folder") mounted.push(createFolderSource(entry, settings));
      else if (entry.kind === "json") mounted.push(createJsonSource(entry, settings));
      else {
        // Session-specific knobs fall back to the corpus-wide settings so an
        // explicit `dsh-sessions` entry behaves like the default one.
        mounted.push(
          createDshSource(
            {
              scope: entry.scope ?? settings.scope,
              includeSubagents: entry.includeSubagents ?? settings.includeSubagents,
              maxSessions: entry.maxSessions ?? settings.maxSessions,
              lookbackDays: entry.lookbackDays ?? settings.lookbackDays,
              minDocumentChars: entry.minDocumentChars ?? settings.minDocumentChars,
              ...entry,
            },
            env,
          ),
        );
      }
    } catch (error) {
      problems.push(`source ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sources: mounted, problems };
}

/**
 * Split a full locator into its source id and source-local part.
 *
 * `notes/diary/2026-10-01.md#L12-L40` addresses the `notes` source; a bare
 * `sessionId#seq` is a legacy locator that belongs to the first DSH source.
 * @param {string} locator - full or legacy locator.
 * @param {{id: string, kind: string}[]} sources - mounted sources.
 * @returns {{sourceId: string, inner: string} | {legacy: true, inner: string} | null} the split.
 */
export function parseLocator(locator, sources) {
  const text = String(locator ?? "").trim();
  if (text === "") return null;
  const slash = text.indexOf("/");
  if (slash > 0 && slash <= 32) {
    const sourceId = text.slice(0, slash);
    if (SOURCE_ID.test(sourceId) && sources.some((source) => source.id === sourceId)) {
      return { sourceId, inner: text.slice(slash + 1) };
    }
  }
  // A bare locator is a session locator only when it has no source prefix:
  // session ids never contain "/", so a slash always means "source/inner".
  if (!text.includes("/") && /^[^\s#]+#\d+$/.test(text)) {
    const dsh = sources.find((source) => source.kind === "dsh-sessions");
    if (dsh) return { sourceId: dsh.id, inner: text };
  }
  return null;
}
