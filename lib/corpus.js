/**
 * Read-only corpus adapter over the host's session history.
 *
 * Reverie never talks to the session files, `ctx.sessions`, or the persistence
 * backend directly: it goes through `ctx.sessionQuery`, the same live-first,
 * replay-validated service that answers every other history read. That keeps
 * the plugin free of storage-format knowledge and gives us a corpus that is by
 * construction the model-visible history rather than a re-parse of it.
 *
 * Only *persisted, non-live* sessions enter the corpus. The conversation the
 * operator is having right now must never become its own experiment material,
 * and a live session's log is still being written.
 *
 * Within one session the corpus is the current model surface, and only what a
 * person or the model actually said: harness injections (`agent-instructions`,
 * `runtime-context`, a skill catalog) share the user role but carry a
 * `source.kind` other than `user`, and reasoning or tool traffic is not
 * ordinary speech. Filtering those here is what keeps the corpus about the
 * operator instead of about the harness.
 *
 * @module dsh-reverie/corpus
 */

import { eventCorpusText, sameDirectory } from "./text.js";

/** In-process cache keyed by corpus scope; invalidated by age. */
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
 * @param {{scope: string, includeSubagents: boolean, maxSessions: number, lookbackDays: number, maxDocuments: number, minDocumentChars: number}} settings - effective settings.
 * @param {string} cwd - current workspace directory.
 * @returns {string} the key.
 */
export function corpusKey(settings, cwd) {
  return JSON.stringify({
    scope: settings.scope,
    cwd: settings.scope === "workspace" ? cwd : "",
    includeSubagents: settings.includeSubagents,
    maxSessions: settings.maxSessions,
    lookbackDays: settings.lookbackDays,
    maxDocuments: settings.maxDocuments,
    minDocumentChars: settings.minDocumentChars,
  });
}

/**
 * Load the corpus snapshot for one run or one search call.
 * @param {{listSessions: Function, readSurface: Function, readEvent: Function}} sessionQuery - host service.
 * @param {Record<string, any>} settings - effective runtime settings.
 * @param {{cwd?: string, refresh?: boolean, now?: number, signal?: AbortSignal}} [options] - call options.
 * @returns {Promise<{documents: any[], sessions: any[], problems: string[], builtAt: number, fromCache: boolean}>}
 *   the normalized corpus.
 */
export async function loadCorpus(sessionQuery, settings, options = {}) {
  const now = options.now ?? Date.now();
  const cwd = options.cwd ?? process.cwd();
  const key = corpusKey(settings, cwd);
  const cached = cache.get(key);
  if (!options.refresh && cached && now - cached.builtAt < settings.cacheTtlMs) {
    return { ...cached, fromCache: true };
  }

  const problems = [];
  const records = await sessionQuery.listSessions(options.signal);
  const cutoff = settings.lookbackDays > 0 ? now - settings.lookbackDays * 86_400_000 : 0;
  const eligible = [];
  for (const record of records) {
    const header = record?.header;
    if (!header) continue;
    // Live sessions are the conversation currently in progress.
    if (record.live) continue;
    if (!record.persisted && !record.live) continue;
    if (header.origin === "subagent" && !settings.includeSubagents) continue;
    if (settings.scope === "workspace" && !sameDirectory(header.cwd, cwd)) continue;
    if (cutoff > 0 && typeof header.createdAt === "number" && header.createdAt < cutoff) continue;
    eligible.push(header);
  }
  eligible.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  const selected = eligible.slice(0, settings.maxSessions);

  /** @type {any[]} */
  const documents = [];
  const sessions = [];
  for (const header of selected) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
    if (documents.length >= settings.maxDocuments) break;
    try {
      // The current model surface, not the raw log: replaced nodes must not
      // reappear in the corpus as if they were still history.
      const surface = await sessionQuery.readSurface(header.id);
      const sessionDocuments = [];
      for (const event of surface.events) {
        if (event.type !== "user/message" && event.type !== "assistant/message") continue;
        const text = eventCorpusText(event).trim();
        if (text.length < settings.minDocumentChars) continue;
        sessionDocuments.push({
          sessionId: header.id,
          seq: event.seq,
          time: event.time,
          role: event.type === "user/message" ? "user" : "assistant",
          text,
          sessionStartedAt: header.createdAt,
          cwd: header.cwd ?? "",
        });
      }
      // A persisted session with nothing corpus-worthy in it (created and
      // closed unused, or only harness traffic) is not part of the corpus and
      // must not inflate the session count.
      if (sessionDocuments.length === 0) continue;
      const room = Math.max(0, settings.maxDocuments - documents.length);
      const kept = sessionDocuments.slice(-room);
      documents.push(...kept);
      sessions.push({
        id: header.id,
        createdAt: header.createdAt,
        cwd: header.cwd ?? "",
        parentSession: header.parentSession ?? "",
        documents: kept.length,
        messages: sessionDocuments.length,
        firstTime: sessionDocuments[0]?.time ?? null,
        lastTime: sessionDocuments[sessionDocuments.length - 1]?.time ?? null,
      });
    } catch (error) {
      // One unreadable session must not erase the rest of the corpus; the
      // failure stays visible instead of being folded into an empty corpus.
      problems.push(`session ${header.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const snapshot = { key, documents, sessions, problems, builtAt: now };
  cache.set(key, snapshot);
  return { ...snapshot, fromCache: false };
}

/**
 * Summarize a corpus snapshot for status output.
 * @param {Awaited<ReturnType<typeof loadCorpus>>} corpus - the loaded corpus.
 * @returns {{documents: number, sessions: number, oldest: number | null, newest: number | null, chars: number}} summary.
 */
export function corpusSummary(corpus) {
  let chars = 0;
  let oldest = null;
  let newest = null;
  for (const document of corpus.documents) {
    chars += document.text.length;
    if (oldest === null || document.time < oldest) oldest = document.time;
    if (newest === null || document.time > newest) newest = document.time;
  }
  return { documents: corpus.documents.length, sessions: corpus.sessions.length, oldest, newest, chars };
}
