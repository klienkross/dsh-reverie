/** The read-only panel routes: listing, metadata, artifacts, and guards. */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULTS } from "../lib/config.js";
import { writeRun } from "../lib/artifacts.js";
import { makeRoutes, REVERIE_API } from "../lib/routes.js";

/**
 * Create a temp run root with one mock run.
 * @param {import("node:test").TestContext} t - test context.
 * @returns {Promise<{root: string, runId: string}>} the fixture.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "reverie-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const meta = {
    run_id: "rev-20261020-190000-abcd",
    day: "2026-10-21",
    mode: "mock",
    provider: "",
    model: "",
    started_at: "2026-10-20T19:00:00Z",
    ended_at: "2026-10-20T19:00:01Z",
    stop_reason: "mock-ended",
    language: "zh",
    corpus: { documents: 2, chars: 40, oldest: "", newest: "", sources: [{ id: "notes", kind: "folder", documents: 2 }], problems: [] },
    budget: { max_steps: 8, max_input_tokens: 60000, max_output_tokens: 2048, timeout_ms: 600000 },
    usage: { input: 0, output: 0, total: 0, steps: 1 },
  };
  await writeRun({
    root,
    meta,
    note: "**主题**\n测试纸条",
    evidence: [{ locator: "notes/a.md#L1-L2", time: "", snippet: "示例" }],
    events: [{ step: 1, kind: "settlement", stopReason: "mock-ended", usage: { total: 0 } }],
    language: "zh",
  });
  return { root, runId: meta.run_id };
}

/**
 * Build a fake request.
 * @param {{url: string, method?: string, address?: string}} input - request facts.
 * @returns {any} fake request.
 */
function request(input) {
  return {
    method: input.method ?? "GET",
    url: input.url,
    socket: { remoteAddress: input.address ?? "127.0.0.1" },
    headers: {},
  };
}

/**
 * Build a fake response that records the written body.
 * @returns {{res: any, status: () => number, body: () => any}} fake response.
 */
function response() {
  const state = { status: 0, body: "" };
  const res = {
    writeHead(status) {
      state.status = status;
    },
    end(text) {
      state.body = text;
    },
  };
  return {
    res,
    status: () => state.status,
    body: () => JSON.parse(state.body || "{}"),
  };
}

/**
 * Run one route handler.
 * @param {any[]} routes - route list.
 * @param {string} apiPath - route path.
 * @param {any} req - fake request.
 * @returns {Promise<{status: number, body: any}>} response.
 */
async function call(routes, apiPath, req) {
  const route = routes.find((candidate) => candidate.path === apiPath);
  assert.ok(route, `route ${apiPath} exists`);
  const out = response();
  await route.handler(req, out.res);
  return { status: out.status(), body: out.body() };
}

test("the runs route lists recorded runs for a loopback GET", async (t) => {
  const { root, runId } = await fixture(t);
  const routes = makeRoutes({ root });
  const result = await call(routes, REVERIE_API.runs, request({ url: `${REVERIE_API.runs}?limit=5` }));
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.runs.length, 1);
  assert.equal(result.body.runs[0].runId, runId);
  assert.equal(result.body.runs[0].mode, "mock");
});

test("the run route returns metadata and refuses unknown ids", async (t) => {
  const { root, runId } = await fixture(t);
  const routes = makeRoutes({ root });
  const ok = await call(routes, REVERIE_API.run, request({ url: `${REVERIE_API.run}?id=${runId}` }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.meta.stop_reason, "mock-ended");
  const bad = await call(routes, REVERIE_API.run, request({ url: `${REVERIE_API.run}?id=../../etc` }));
  assert.equal(bad.status, 404);
  assert.match(bad.body.error, /invalid run id/);
});

test("the file route serves allowlisted artifacts only", async (t) => {
  const { root, runId } = await fixture(t);
  const routes = makeRoutes({ root });
  const report = await call(routes, REVERIE_API.file, request({ url: `${REVERIE_API.file}?id=${runId}&name=report` }));
  assert.equal(report.status, 200);
  assert.match(report.body.content, /Reverie 报告/);
  const handoff = await call(routes, REVERIE_API.file, request({ url: `${REVERIE_API.file}?id=${runId}&name=handoff` }));
  assert.match(handoff.body.content, /私人纸条/);
  const unknown = await call(routes, REVERIE_API.file, request({ url: `${REVERIE_API.file}?id=${runId}&name=../../package.json` }));
  assert.equal(unknown.status, 400);
});

test("non-loopback peers and wrong methods are refused", async (t) => {
  const { root } = await fixture(t);
  const routes = makeRoutes({ root });
  const remote = await call(routes, REVERIE_API.runs, request({ url: REVERIE_API.runs, address: "192.168.1.9" }));
  assert.equal(remote.status, 403);
  const post = await call(routes, REVERIE_API.runs, request({ url: REVERIE_API.runs, method: "POST" }));
  assert.equal(post.status, 405);
});

test("an empty run root lists nothing instead of failing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reverie-routes-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = makeRoutes({ root });
  const result = await call(routes, REVERIE_API.runs, request({ url: REVERIE_API.runs }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.runs, []);
});

test("the defaults fixture is untouched by route construction", () => {
  assert.equal(DEFAULTS.mode, "mock");
});
