/** Plugin surface: registration, every tool, and a full mock + live run. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { apply, name, REVERIE_GUIDANCE } from "../lib/index.js";
import { clearCorpusCache } from "../lib/corpus.js";
import { fakeCtx, fakeLlm, fixtureCorpus } from "./helpers/host.mjs";

const cwd = process.cwd();

/**
 * Give one test its own `$DSH_HOME`.
 * @param {import("node:test").TestContext} t - current test context.
 * @returns {Promise<string>} the temporary home directory.
 */
async function useHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), "reverie-plugin-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

/**
 * Mount the plugin over a fake host.
 * @param {{llm?: any, sessionQuery?: any}} services - host services.
 * @returns {{tools: Map<string, any>, sections: any[]}} registered surface.
 */
function mount(services) {
  const { ctx, tools, sections } = fakeCtx(services);
  apply(ctx, { announceToAgent: true, enabled: true });
  return { tools: new Map(tools.map((tool) => [tool.name, tool])), sections };
}

/**
 * Build an execution context for one call.
 * @returns {any} tool run context.
 */
function execution() {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  };
}

test("apply registers seven tools and one announcement", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools, sections } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  assert.deepEqual(
    [...tools.keys()].sort(),
    ["reverie_config", "reverie_read", "reverie_report", "reverie_run", "reverie_search", "reverie_sources", "reverie_status"],
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "plugin:dsh-reverie");
  assert.equal(sections[0].text, REVERIE_GUIDANCE);
  assert.equal(name, "reverie");
});

test("reverie_status reports sources, corpus size, config path and route readiness", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const value = await tools.get("reverie_status").execute({}, execution());
  assert.equal(value.ok, true);
  assert.equal(value.sources, 1);
  assert.equal(value.documents, 6);
  assert.match(value.message, /dsh-reverie/);
  assert.match(value.message, /dsh（dsh-sessions）/);
  assert.match(value.message, /mock/);
  assert.match(value.configPath, /reverie.*config\.json$/);
});

test("reverie_sources lists the corpus sources and their groups", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const value = await tools.get("reverie_sources").execute({ limit: 5 }, execution());
  assert.equal(value.ok, true);
  assert.equal(value.sources, 1);
  assert.ok(value.items.some((line) => line.includes("session-alpha")));
  assert.ok(value.items.some((line) => line.includes("session-beta")));
});

test("reverie_search returns ranked evidence with source-prefixed locators", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const value = await tools.get("reverie_search").execute({ query: "书架" }, execution());
  assert.equal(value.ok, true);
  assert.ok(value.hits.length >= 1);
  const first = value.hits[0];
  assert.match(first.locator, /^dsh\/session-[a-z]+#\d+$/);
  assert.equal(first.sourceId, "dsh");
  assert.match(value.message, /dsh\/session-alpha#0|dsh\/session-alpha#1/);
});

test("reverie_search filters by source and role", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const byRole = await tools.get("reverie_search").execute({ query: "书架", role: "assistant" }, execution());
  assert.equal(byRole.ok, true);
  assert.ok(byRole.hits.every((hit) => hit.kind === "reply"));
  const bySource = await tools.get("reverie_search").execute({ query: "书架", source: "dsh" }, execution());
  assert.ok(bySource.hits.length >= 1);
  const missing = await tools.get("reverie_search").execute({ query: "书架", source: "nope" }, execution());
  assert.equal(missing.hits.length, 0);
});

test("reverie_search reports an honest miss", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const value = await tools.get("reverie_search").execute({ query: "zzqqxx" }, execution());
  assert.equal(value.ok, true);
  assert.equal(value.hits.length, 0);
  assert.match(value.message, /没有可用命中/);
});

test("reverie_read expands a raw locator", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const value = await tools.get("reverie_read").execute({ locator: "dsh/session-alpha#1" }, execution());
  assert.equal(value.ok, true);
  assert.match(value.message, /书架允许一本书被放错位置/);
  assert.equal(value.sourceId, "dsh");
});

test("reverie_read accepts a legacy session locator", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const value = await tools.get("reverie_read").execute({ locator: "session-alpha#1" }, execution());
  assert.equal(value.ok, true);
  assert.match(value.message, /书架允许一本书被放错位置/);
});

test("reverie_read fails loudly on an unreadable locator", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const missing = await tools.get("reverie_read").execute({ locator: "dsh/session-alpha#99" }, execution());
  assert.equal(missing.ok, false);
  assert.match(missing.message, /读取失败/);
  const unknown = await tools.get("reverie_read").execute({ locator: "nope/x#1" }, execution());
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /unknown locator/);
});

test("reverie_config validates, merges, persists and reports rejected keys", async (t) => {
  const home = await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const tool = tools.get("reverie_config");
  const updated = await tool.execute({ set: { maxSteps: 3, bogus: 1 } }, execution());
  assert.equal(updated.ok, true);
  assert.equal(updated.settings.maxSteps, 3);
  assert.ok(updated.rejected.some((entry) => entry.startsWith("bogus")));
  const persisted = JSON.parse(await readFile(path.join(home, "reverie", "config.json"), "utf8"));
  assert.equal(persisted.maxSteps, 3);
  const withSources = await tool.execute({ set: { sources: [{ id: "notes", kind: "folder", root: home }] } }, execution());
  assert.equal(withSources.settings.sources.length, 1);
  const reset = await tool.execute({ reset: true }, execution());
  assert.equal(reset.settings.mode, "mock");
  assert.deepEqual(reset.settings.sources, []);
});

test("a folder source feeds every tool, not only the session source", async (t) => {
  await useHome(t);
  const root = await mkdtemp(path.join(tmpdir(), "reverie-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "书架.md"), "# 书架\n\n把记忆当成书架而不是数据库，允许错放。", "utf8");
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  await tools
    .get("reverie_config")
    .execute({ set: { sources: [{ id: "notes", kind: "folder", root, extensions: ["md"] }], minDocumentChars: 4 } }, execution());
  const status = await tools.get("reverie_status").execute({}, execution());
  assert.equal(status.ok, true);
  assert.match(status.message, /notes（folder）/);
  const search = await tools.get("reverie_search").execute({ query: "书架" }, execution());
  assert.ok(search.hits.length >= 1);
  const locator = search.hits[0].locator;
  assert.match(locator, /^notes\/书架\.md#L\d+-L\d+$/);
  const read = await tools.get("reverie_read").execute({ locator }, execution());
  assert.equal(read.ok, true);
  assert.match(read.message, /允许错放/);
});

test("reverie_run writes a complete mock run without calling any model", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const llm = fakeLlm([{ text: "must not be called" }]);
  const { tools } = mount({ llm, sessionQuery: fixtureCorpus(cwd) });
  const value = await tools.get("reverie_run").execute({ live: false }, execution());
  assert.equal(value.ok, true);
  assert.equal(value.mode, "mock");
  assert.equal(value.stopReason, "mock-ended");
  assert.equal(llm.requests.length, 0);
  assert.match(value.runId, /^rev-\d{8}-\d{6}-[a-z0-9]{4}$/);
  const report = await readFile(value.reportPath, "utf8");
  assert.match(report, /# Reverie 报告/);
  const handoff = await readFile(value.handoffPath, "utf8");
  assert.match(handoff, /REVERIE \/ 私人纸条/);
  const runJson = JSON.parse(await readFile(path.join(path.dirname(value.reportPath), "run.json"), "utf8"));
  assert.equal(runJson.mode, "mock");
  assert.equal(runJson.usage.steps, 1);
  assert.equal(runJson.corpus.sources[0].id, "dsh");
});

test("reverie_run live uses the host route, dispatches inner tools and keeps the note", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const llm = fakeLlm([
    { toolCalls: [{ id: "c1", name: "reverie_search", arguments: { query: "书架" } }] },
    {
      toolCalls: [
        {
          id: "c2",
          name: "reverie_note",
          arguments: { note: "**主题**\n书架与错位\n\n**证据**\n- `dsh/session-alpha#1` 书架允许错放。" },
        },
      ],
    },
    { text: "这一趟到这里。" },
  ]);
  const { tools } = mount({ llm, sessionQuery: fixtureCorpus(cwd) });
  await tools.get("reverie_config").execute({ set: { mode: "live" } }, execution());
  const value = await tools.get("reverie_run").execute({ live: true }, execution());
  assert.equal(value.ok, true);
  assert.equal(value.mode, "live");
  assert.equal(value.stopReason, "model-ended");
  assert.equal(value.steps, 3);
  assert.equal(llm.requests.length, 3);
  assert.deepEqual(llm.requests[0].tools, ["reverie_search", "reverie_read", "reverie_note"]);
  assert.equal(llm.requests[0].provider, "fake-provider");
  assert.equal(llm.requests[0].model, "fake-model");
  assert.match(value.message, /书架与错位/);
  const handoff = await readFile(value.handoffPath, "utf8");
  assert.match(handoff, /dsh\/session-alpha#1/);
  const report = await readFile(value.reportPath, "utf8");
  assert.match(report, /dsh\/session-alpha#1/);
});

test("a second run is refused while one is in flight", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const slow = { ...fixtureCorpus(cwd), listSessions: () => new Promise(() => {}) };
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: slow });
  const pending = tools.get("reverie_run").execute({ live: false }, execution());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await tools.get("reverie_run").execute({ live: false }, execution());
  assert.equal(second.ok, false);
  assert.match(second.message, /已经有一趟/);
  pending.catch(() => {});
});

test("reverie_report lists runs and reads one artifact", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  const run = await tools.get("reverie_run").execute({ live: false }, execution());
  const listed = await tools.get("reverie_report").execute({}, execution());
  assert.equal(listed.ok, true);
  assert.ok(listed.runs.includes(run.runId));
  const report = await tools.get("reverie_report").execute({ run: run.runId, file: "report" }, execution());
  assert.equal(report.ok, true);
  assert.match(report.message, /Reverie 报告/);
  const bad = await tools.get("reverie_report").execute({ run: "../../etc", file: "report" }, execution());
  assert.equal(bad.ok, false);
  assert.match(bad.message, /invalid run id/);
});

test("a folder-only composition does not need sessionQuery", async (t) => {
  await useHome(t);
  const root = await mkdtemp(path.join(tmpdir(), "reverie-only-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.md"), "# a\n\n只有笔记，没有会话历史。", "utf8");
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]) });
  await tools
    .get("reverie_config")
    .execute({ set: { sources: [{ id: "notes", kind: "folder", root }], minDocumentChars: 4 } }, execution());
  const status = await tools.get("reverie_status").execute({}, execution());
  assert.equal(status.ok, true);
  assert.equal(status.documents, 1);
  const run = await tools.get("reverie_run").execute({ live: false }, execution());
  assert.equal(run.ok, true);
  assert.equal(run.mode, "mock");
});

test("with no readable corpus the tools say why instead of pretending", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { tools } = mount({ llm: fakeLlm([]), sessionQuery: fixtureCorpus(cwd) });
  await tools
    .get("reverie_config")
    .execute({ set: { sources: [{ id: "gone", kind: "folder", root: path.join(tmpdir(), "reverie-empty-root") }] } }, execution());
  const run = await tools.get("reverie_run").execute({ live: false }, execution());
  assert.equal(run.ok, false);
  assert.match(run.message, /没有可读的语料/);
});
