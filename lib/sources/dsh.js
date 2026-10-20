/**
 * DeepSeek Harness session-history source.
 *
 * The shipped corpus: persisted, non-live sessions, read through
 * `ctx.sessionQuery`, current surface only, human-authored user text plus
 * assistant text. It is one source among several now, not the whole corpus.
 *
 * @module dsh-reverie/sources/dsh
 */

import { eventCorpusText, sameDirectory } from "../text.js";

/** Event types that can contribute corpus text. */
const CORPUS_EVENT_TYPES = new Set(["user/message", "assistant/message"]);

/**
 * Describe a DSH-source problem in one line.
 * @param {unknown} error - thrown value.
 * @returns {string} message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the DSH session source.
 * @param {Record<string, any>} entry - `{id, kind: "dsh-sessions", scope?, ...}`.
 * @param {{sessionQuery: any, cwd: string, now?: number}} env - host bindings.
 * @returns {any} the source.
 */
export function createDshSource(entry, env) {
  const scope = entry.scope === "all" ? "all" : "workspace";
  const includeSubagents = entry.includeSubagents === true;
  const maxSessions = Number.isFinite(entry.maxSessions) ? Number(entry.maxSessions) : 24;
  const lookbackDays = Number.isFinite(entry.lookbackDays) ? Number(entry.lookbackDays) : 0;
  const minDocumentChars = Number.isFinite(entry.minDocumentChars) ? Number(entry.minDocumentChars) : 24;

  return {
    id: entry.id,
    kind: "dsh-sessions",
    describe() {
      return `dsh sessions · scope ${scope} · ≤${maxSessions} sessions`;
    },

    /**
     * Load the corpus slice from persisted sessions.
     * @param {{signal?: AbortSignal}} [options] - cancellation.
     * @returns {Promise<{documents: any[], groups: any[], problems: string[]}>} normalized corpus slice.
     */
    async load(options = {}) {
      const problems = [];
      const sessionQuery = env.sessionQuery;
      if (!sessionQuery) {
        return { documents: [], groups: [], problems: ["sessionQuery is not available in this host"] };
      }
      const now = env.now ?? Date.now();
      const cutoff = lookbackDays > 0 ? now - lookbackDays * 86_400_000 : 0;
      const records = await sessionQuery.listSessions(options.signal);
      const eligible = [];
      for (const record of records) {
        const header = record?.header;
        if (!header) continue;
        // The conversation in progress is never its own experiment material.
        if (record.live) continue;
        if (!record.persisted) continue;
        if (header.origin === "subagent" && !includeSubagents) continue;
        if (scope === "workspace" && !sameDirectory(header.cwd, env.cwd)) continue;
        if (cutoff > 0 && typeof header.createdAt === "number" && header.createdAt < cutoff) continue;
        eligible.push(header);
      }
      eligible.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
      const selected = eligible.slice(0, maxSessions);

      const documents = [];
      const groups = [];
      for (const header of selected) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
        try {
          // The current model surface, not the raw log: replaced nodes must not
          // reappear in the corpus as if they were still history.
          const surface = await sessionQuery.readSurface(header.id);
          const sessionDocuments = [];
          for (const event of surface.events) {
            if (!CORPUS_EVENT_TYPES.has(event.type)) continue;
            const text = eventCorpusText(event).trim();
            if (text.length < minDocumentChars) continue;
            sessionDocuments.push({
              locator: `${header.id}#${event.seq}`,
              text,
              title: "",
              kind: event.type === "user/message" ? "message" : "reply",
              time: event.time,
              group: header.id,
              meta: { session: header.id, role: event.type === "user/message" ? "user" : "assistant" },
            });
          }
          // A persisted session with nothing corpus-worthy in it (created and
          // closed unused, or only harness traffic) is not part of the corpus.
          if (sessionDocuments.length === 0) continue;
          documents.push(...sessionDocuments);
          groups.push({
            name: header.id,
            documents: sessionDocuments.length,
            firstTime: sessionDocuments[0].time,
            lastTime: sessionDocuments[sessionDocuments.length - 1].time,
            cwd: header.cwd ?? "",
          });
        } catch (error) {
          // One unreadable session must not erase the rest of the corpus.
          problems.push(`session ${header.id}: ${messageOf(error)}`);
        }
      }
      return { documents, groups, problems };
    },

    /**
     * Expand one `sessionId#seq` locator into its raw event window.
     * @param {string} locator - inner locator.
     * @returns {Promise<{documents: any[], problems: string[]}>} the window.
     */
    async read(locator) {
      const match = /^(.+)#(\d+)$/.exec(locator);
      if (!match) throw new Error(`unsupported session locator: ${locator}`);
      const sessionId = match[1];
      const seq = Number(match[2]);
      const window = await env.sessionQuery.readEvent({ sessionId, seq, before: 1, after: 1 });
      const documents = window.events
        .map((event) => {
          const text = eventCorpusText(event).trim();
          if (text === "") return null;
          return {
            locator: `${sessionId}#${event.seq}`,
            text,
            title: "",
            kind: "message",
            time: event.time,
            group: sessionId,
            meta: { session: sessionId },
          };
        })
        .filter(Boolean);
      return { documents, problems: [] };
    },
  };
}
