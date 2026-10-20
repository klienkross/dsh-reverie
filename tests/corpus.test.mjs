/** Corpus orchestration: sources, locator prefixes, caps, cache, failures. */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULTS } from "../lib/config.js";
import { clearCorpusCache, corpusSummary, loadCorpus, readLocator } from "../lib/corpus.js";
import { fakeSessionQuery } from "./helpers/host.mjs";

const DAY = 86_400_000;
const WORK = "D:\\work";

/**
 * Build settings for one test.
 * @param {Record<string, unknown>} [overrides] - field overrides.
 * @returns {Record<string, any>} effective settings.
 */
function settings(overrides = {}) {
  return { ...DEFAULTS, minDocumentChars: 4, ...overrides };
}

/**
 * Build one session fixture.
 * @param {string} id - session id.
 * @param {string} cwd - workspace directory.
 * @param {any[]} messages - messages.
 * @param {Record<string, unknown>} [extra] - extra fields.
 * @returns {any} fixture session.
 */
function session(id, cwd, messages, extra = {}) {
  return { id, createdAt: 1_000, cwd, messages, ...extra };
}

test("the default corpus is the dsh session source, locators prefixed with its id", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [session("s1", WORK, [{ seq: 0, time: 2_000, role: "user", text: "这条消息足够长，会被收进语料里。" }])],
  });
  const corpus = await loadCorpus(settings(), { sessionQuery: service, cwd: WORK, now: 5_000, refresh: true });
  assert.equal(corpus.sources.length, 1);
  assert.equal(corpus.sources[0].id, "dsh");
  assert.equal(corpus.sources[0].kind, "dsh-sessions");
  assert.equal(corpus.documents.length, 1);
  assert.equal(corpus.documents[0].locator, "dsh/s1#0");
  assert.equal(corpus.documents[0].sourceId, "dsh");
  assert.equal(corpusSummary(corpus).sources, 1);
});

test("a folder source joins the corpus and keeps its own locator space", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reverie-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.md"), "# 标题\n\n第一段内容，关于书架与索引。\n\n## 小节\n\n第二段内容。", "utf8");
  clearCorpusCache();
  const corpus = await loadCorpus(
    settings({
      sources: [{ id: "notes", kind: "folder", root }],
      minDocumentChars: 1,
    }),
    { cwd: WORK, now: 5_000, refresh: true },
  );
  assert.equal(corpus.sources[0].id, "notes");
  assert.ok(corpus.documents.length >= 2);
  assert.ok(corpus.documents.every((document) => document.locator.startsWith("notes/")));
  const first = corpus.documents.find((document) => document.text.includes("书架"));
  assert.ok(first);
  const expanded = await readLocator(settings({ sources: [{ id: "notes", kind: "folder", root }] }), first.locator, {
    cwd: WORK,
  });
  assert.equal(expanded.sourceId, "notes");
  assert.match(expanded.documents[0].text, /书架/);
});

test("one broken source is reported without erasing the healthy one", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [session("s1", WORK, [{ seq: 0, time: 2_000, role: "user", text: "健康源里的一条消息。" }])],
  });
  const corpus = await loadCorpus(
    settings({
      sources: [
        { id: "dsh", kind: "dsh-sessions", scope: "workspace" },
        { id: "gone", kind: "folder", root: path.join(tmpdir(), "definitely-not-here-reverie") },
      ],
    }),
    { sessionQuery: service, cwd: WORK, now: 5_000, refresh: true },
  );
  assert.equal(corpus.documents.length, 1);
  assert.equal(corpus.documents[0].sourceId, "dsh");
  const broken = corpus.sources.find((source) => source.id === "gone");
  assert.equal(broken.documents, 0);
  assert.ok(corpus.problems.some((problem) => problem.includes("gone")));
});

test("maxDocuments clamps the total across sources", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reverie-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["a.md", "b.md", "c.md"]) {
    await writeFile(path.join(root, name), `# ${name}\n\n${name} 的内容文本。`, "utf8");
  }
  clearCorpusCache();
  const corpus = await loadCorpus(
    settings({ sources: [{ id: "notes", kind: "folder", root }], maxDocuments: 2, minDocumentChars: 1 }),
    { cwd: WORK, now: 5_000, refresh: true },
  );
  assert.equal(corpus.documents.length, 2);
});

test("a second load reuses the cache and refresh rebuilds it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reverie-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.md"), "# a\n\n缓存测试文本。", "utf8");
  const configured = settings({ sources: [{ id: "notes", kind: "folder", root }] });
  clearCorpusCache();
  const first = await loadCorpus(configured, { cwd: WORK, now: 5_000 });
  assert.equal(first.fromCache, false);
  const second = await loadCorpus(configured, { cwd: WORK, now: 6_000 });
  assert.equal(second.fromCache, true);
  const third = await loadCorpus(configured, { cwd: WORK, now: 7_000, refresh: true });
  assert.equal(third.fromCache, false);
});

test("an unknown locator is refused instead of guessed", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({ sessions: [] });
  await assert.rejects(
    readLocator(settings(), "nope/whatever#1", { sessionQuery: service, cwd: WORK }),
    /unknown locator/,
  );
});

test("legacy session locators still resolve through the dsh source", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [
      session("s1", WORK, [
        { seq: 0, time: 1_000, role: "user", text: "第一条消息。" },
        { seq: 1, time: 2_000, role: "assistant", text: "第二条消息。" },
      ]),
    ],
  });
  const expanded = await readLocator(settings(), "s1#1", { sessionQuery: service, cwd: WORK });
  assert.equal(expanded.sourceId, "dsh");
  const target = expanded.documents.find((document) => document.locator === "dsh/s1#1");
  assert.ok(target);
  assert.match(target.text, /第二条消息/);
});

test("lookbackDays still filters the session source", async () => {
  clearCorpusCache();
  const now = 10 * DAY;
  const service = fakeSessionQuery({
    sessions: [
      session("old", WORK, [{ seq: 0, time: now - 30 * DAY, role: "user", text: "很久以前的一条消息。" }], {
        createdAt: now - 30 * DAY,
      }),
      session("new", WORK, [{ seq: 0, time: now - DAY, role: "user", text: "较新的一条消息。" }], {
        createdAt: now - DAY,
      }),
    ],
  });
  const corpus = await loadCorpus(settings({ lookbackDays: 7 }), { sessionQuery: service, cwd: WORK, now, refresh: true });
  assert.deepEqual(
    corpus.sources[0].groups.map((group) => group.name),
    ["new"],
  );
});
