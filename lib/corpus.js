/**
 * Corpus orchestration.
 *
 * The corpus is whatever the configured sources return: one folder, one export,
 * the harness session history, or several at once. This module mounts the
 * sources, prefixes every document locator with its source id, applies the
 * corpus-wide caps, and caches the result. It knows nothing about any specific
 * store — adding one is a source adapter, not a change here.
 *
 * Read-only by construction: sources only read, and nothing in this module
 * writes anywhere.
 *
 * @module dsh-reverie/corpus
 */

import { createSources, defaultSources, parseLocator } from "./sources/index.js";

/** In-process cache keyed by the source configuration; invalidated by age. */
const cache = new Map();

/**
 * Drop every cached corpus snapshot. Used by tests and by `refresh: true`.
 * @returns {void}
 */
export function clearCorpusCache() {
  cache.clear();
}

/**
 * Build a deterministic cache key for one corpus request.
 * @param {Record<string, any>} settings - effective runtime settings.
 * @param {string} cwd - current workspace directory.
 * @returns {string} the key.
 */
export function corpusKey(settings, cwd) {
  const sources = Array.isArray(settings.sources) && settings.sources.length > 0 ? settings.sources : defaultSources(settings);
  return JSON.stringify({
    sources,
    cwd: cwd ?? "",
    maxDocuments: settings.maxDocuments,
    minDocumentChars: settings.minDocumentChars,
  });
}

/**
 * Load the corpus snapshot for one run or one search call.
 * @param {Record<string, any>} settings - effective runtime settings.
 * @param {{sessionQuery?: any, cwd?: string, now?: number, refresh?: boolean, signal?: AbortSignal}} [options] - host bindings and call options.
 * @returns {Promise<{documents: any[], sources: any[], problems: string[], builtAt: number, key: string, fromCache: boolean}>}
 *   the normalized corpus.
 */
export async function loadCorpus(settings, options = {}) {
  const now = options.now ?? Date.now();
  const cwd = options.cwd ?? process.cwd();
  const key = corpusKey(settings, cwd);
  const cached = cache.get(key);
  if (!options.refresh && cached && now - cached.builtAt < settings.cacheTtlMs) {
    return { ...cached, fromCache: true };
  }

  const mounted = createSources(settings, { sessionQuery: options.sessionQuery, cwd, now });
  const problems = [...mounted.problems];
  const documents = [];
  const sources = [];
  for (const source of mounted.sources) {
    const remaining = Math.max(0, settings.maxDocuments - documents.length);
    if (remaining === 0) break;
    try {
      const result = await source.load({ signal: options.signal, limit: remaining });
      problems.push(...result.problems.map((problem) => `${source.id}: ${problem}`));
      const kept = [];
      for (const document of result.documents) {
        if (documents.length >= settings.maxDocuments) break;
        if (String(document.text ?? "").trim().length < settings.minDocumentChars) continue;
        const entry = {
          ...document,
          locator: `${source.id}/${document.locator}`,
          sourceId: source.id,
          sourceKind: source.kind,
        };
        documents.push(entry);
        kept.push(entry);
      }
      sources.push({
        id: source.id,
        kind: source.kind,
        label: typeof source.describe === "function" ? source.describe() : source.kind,
        documents: kept.length,
        groups: result.groups ?? [],
        problems: result.problems ?? [],
      });
    } catch (error) {
      // One broken source must not erase the rest of the corpus.
      const problem = error instanceof Error ? error.message : String(error);
      problems.push(`${source.id}: ${problem}`);
      sources.push({
        id: source.id,
        kind: source.kind,
        label: typeof source.describe === "function" ? source.describe() : source.kind,
        documents: 0,
        groups: [],
        problems: [problem],
      });
    }
  }

  const snapshot = { documents, sources, problems, builtAt: now, key };
  cache.set(key, snapshot);
  return { ...snapshot, fromCache: false };
}

/**
 * Read one locator back through the source that owns it.
 * @param {Record<string, any>} settings - effective runtime settings.
 * @param {string} locator - full locator (`source/inner`) or a legacy session locator.
 * @param {{sessionQuery?: any, cwd?: string, now?: number}} env - host bindings.
 * @returns {Promise<{sourceId: string, inner: string, documents: any[]}>} expanded documents.
 */
export async function readLocator(settings, locator, env) {
  const mounted = createSources(settings, env);
  const parsed = parseLocator(locator, mounted.sources);
  if (parsed === null) throw new Error(`unknown locator: ${locator}`);
  if (parsed.legacy) throw new Error("legacy locator could not be bound to a session source");
  const source = mounted.sources.find((candidate) => candidate.id === parsed.sourceId);
  if (!source) throw new Error(`unknown source in locator: ${parsed.sourceId}`);
  if (typeof source.read !== "function") {
    throw new Error(`source ${source.id} cannot expand locators; use reverie_search to read its text`);
  }
  const result = await source.read(parsed.inner);
  return {
    sourceId: parsed.sourceId,
    inner: parsed.inner,
    documents: result.documents.map((document) => ({
      ...document,
      locator: document.locator.startsWith(`${source.id}/`) ? document.locator : `${source.id}/${document.locator}`,
      sourceId: source.id,
      sourceKind: source.kind,
    })),
  };
}

/**
 * Summarize a corpus snapshot for status output.
 * @param {Awaited<ReturnType<typeof loadCorpus>>} corpus - the loaded corpus.
 * @returns {{documents: number, sources: number, oldest: number | null, newest: number | null, chars: number}} summary.
 */
export function corpusSummary(corpus) {
  let chars = 0;
  let oldest = null;
  let newest = null;
  for (const document of corpus.documents) {
    chars += document.text.length;
    if (typeof document.time === "number" && Number.isFinite(document.time)) {
      if (oldest === null || document.time < oldest) oldest = document.time;
      if (newest === null || document.time > newest) newest = document.time;
    }
  }
  return { documents: corpus.documents.length, sources: corpus.sources.length, oldest, newest, chars };
}
