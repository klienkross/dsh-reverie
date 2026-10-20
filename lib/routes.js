/**
 * Read-only HTTP routes for the Reverie panel.
 *
 * The web panel is a viewer: it lists recorded runs and reads their artifacts
 * through the same validated reader the tools use. There is deliberately no
 * route that starts a run — spending model budget stays an explicit agent/tool
 * decision, not something a page refresh can trigger.
 *
 * @module dsh-reverie/routes
 */

import { listRuns, readRunFile } from "./runs.js";
import { readConfig, runsRoot } from "./config.js";
import { loadCorpus } from "./corpus.js";

/** Route prefixes the client bundle calls. */
export const REVERIE_API = Object.freeze({
  runs: "/api/dsh-reverie/runs",
  run: "/api/dsh-reverie/run",
  file: "/api/dsh-reverie/file",
  corpus: "/api/dsh-reverie/corpus",
});

/** Artifact names the viewer may request. */
const VIEWER_FILES = {
  report: "report.md",
  handoff: "handoff.md",
  trail: "events.jsonl",
  meta: "run.json",
  usage: "usage.json",
};

/** Maximum artifact bytes returned to the browser in one response. */
const MAX_BYTES = 1024 * 1024;

/**
 * Whether a request comes from this machine.
 * @param {any} req - Node request.
 * @returns {boolean} true for loopback peers.
 */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Write one JSON response.
 * @param {any} res - Node response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 * @returns {void}
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * Guard a route: loopback-only, exact method.
 * @param {any} req - Node request.
 * @param {any} res - Node response.
 * @param {string} method - expected method.
 * @returns {boolean} true when the handler should continue.
 */
function guard(req, res, method) {
  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
    return false;
  }
  if (req.method !== method) {
    writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` });
    return false;
  }
  return true;
}

/**
 * Read the request's query string.
 * @param {any} req - Node request.
 * @returns {URLSearchParams} parsed query.
 */
function queryOf(req) {
  return new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
}

/**
 * Clamp one integer query parameter.
 * @param {URLSearchParams} params - query.
 * @param {string} key - parameter name.
 * @param {number} fallback - value used when absent or invalid.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the clamped integer.
 */
function intParam(params, key, fallback, min, max) {
  const raw = Number(params.get(key) ?? "");
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

/**
 * Build the route list for `ctx.webServer.register`.
 * @param {{root?: string}} [options] - run root override (tests).
 * @returns {{kind: "exact", path: string, handler: Function}[]} routes.
 */
export function makeRoutes(options = {}) {
  const root = options.root ?? runsRoot();
  return [
    {
      kind: "exact",
      path: REVERIE_API.runs,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          const limit = intParam(queryOf(req), "limit", 20, 1, 50);
          const runs = await listRuns(root, limit);
          writeJson(res, 200, { ok: true, root, runs });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: "exact",
      path: REVERIE_API.run,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const runId = queryOf(req).get("id") ?? "";
        try {
          const artifact = await readRunFile(root, runId, "run.json");
          writeJson(res, 200, { ok: true, runId: artifact.runId, meta: JSON.parse(artifact.content) });
        } catch (error) {
          writeJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: "exact",
      path: REVERIE_API.file,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const params = queryOf(req);
        const runId = params.get("id") ?? "";
        const alias = params.get("name") ?? "report";
        const name = VIEWER_FILES[alias];
        if (name === undefined) {
          writeJson(res, 400, { ok: false, error: `unknown artifact: ${alias}` });
          return;
        }
        try {
          const artifact = await readRunFile(root, runId, name);
          if (Buffer.byteLength(artifact.content, "utf8") > MAX_BYTES) {
            writeJson(res, 413, { ok: false, error: `artifact exceeds ${MAX_BYTES} bytes` });
            return;
          }
          writeJson(res, 200, { ok: true, runId: artifact.runId, name: alias, content: artifact.content });
        } catch (error) {
          writeJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: "exact",
      path: REVERIE_API.corpus,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        try {
          const { settings } = await readConfig();
          const corpus = await loadCorpus(settings, { cwd: process.cwd() });
          /** @type {Map<string, number>} */
          const counts = new Map();
          let oldest = null;
          let newest = null;
          for (const document of corpus.documents) {
            if (typeof document.time !== "number" || !Number.isFinite(document.time)) continue;
            const day = new Date(document.time).toISOString().slice(0, 10);
            counts.set(day, (counts.get(day) ?? 0) + 1);
            if (oldest === null || document.time < oldest) oldest = document.time;
            if (newest === null || document.time > newest) newest = document.time;
          }
          writeJson(res, 200, {
            ok: true,
            documents: corpus.documents.length,
            sources: corpus.sources.map((source) => ({ id: source.id, kind: source.kind, documents: source.documents })),
            oldest,
            newest,
            days: [...counts.entries()]
              .sort((left, right) => left[0].localeCompare(right[0]))
              .map(([day, documents]) => ({ day, documents })),
            problems: corpus.problems,
          });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];
}
