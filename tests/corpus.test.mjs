/** Corpus: scope filters, caps, cache reuse, visible per-session failures. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { clearCorpusCache, corpusSummary, loadCorpus } from "../lib/corpus.js";
import { DEFAULTS } from "../lib/config.js";
import { fakeSessionQuery } from "./helpers/host.mjs";

const DAY = 86_400_000;

/**
 * Build settings for one test.
 * @param {Record<string, unknown>} [overrides] - field overrides.
 * @returns {Record<string, any>} effective settings.
 */
function settings(overrides = {}) {
  return { ...DEFAULTS, minDocumentChars: 4, ...overrides };
}

test("only persisted, non-live, non-subagent sessions in the same workspace enter the corpus", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [
      {
        id: "keep",
        createdAt: 1_000,
        cwd: "D:\\work",
        messages: [{ seq: 0, time: 2_000, role: "user", text: "这条消息足够长，会被收进语料里。" }],
      },
      {
        id: "live",
        createdAt: 1_000,
        cwd: "D:\\work",
        live: true,
        messages: [{ seq: 0, time: 2_000, role: "user", text: "正在进行的对话不该进语料。" }],
      },
      {
        id: "child",
        createdAt: 1_000,
        cwd: "D:\\work",
        origin: "subagent",
        messages: [{ seq: 0, time: 2_000, role: "user", text: "子代理的噪声默认不进语料。" }],
      },
      {
        id: "elsewhere",
        createdAt: 1_000,
        cwd: "D:\\other",
        messages: [{ seq: 0, time: 2_000, role: "user", text: "别的项目的会话不该进本工作区语料。" }],
      },
    ],
  });
  const corpus = await loadCorpus(service, settings(), { cwd: "D:\\work", now: 10_000, refresh: true });
  assert.deepEqual(
    corpus.sessions.map((session) => session.id),
    ["keep"],
  );
  assert.equal(corpus.documents.length, 1);
  assert.equal(corpus.documents[0].role, "user");
});

test("scope=all reads every workspace but still skips live sessions", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [
      {
        id: "a",
        createdAt: 1_000,
        cwd: "D:\\one",
        messages: [{ seq: 0, time: 2_000, role: "user", text: "第一个工作区的消息内容。" }],
      },
      {
        id: "b",
        createdAt: 1_500,
        cwd: "D:\\two",
        messages: [{ seq: 0, time: 2_500, role: "assistant", text: "第二个工作区的消息内容。" }],
      },
      {
        id: "c",
        createdAt: 1_700,
        cwd: "D:\\two",
        live: true,
        messages: [{ seq: 0, time: 2_700, role: "assistant", text: "活跃会话仍然被排除在外。" }],
      },
    ],
  });
  const corpus = await loadCorpus(service, settings({ scope: "all" }), { cwd: "D:\\none", now: 10_000, refresh: true });
  assert.deepEqual(
    corpus.sessions.map((session) => session.id),
    ["b", "a"],
  );
});

test("lookbackDays drops older sessions and maxDocuments truncates the newest tail", async () => {
  clearCorpusCache();
  const now = 10 * DAY;
  const service = fakeSessionQuery({
    sessions: [
      {
        id: "old",
        createdAt: now - 30 * DAY,
        cwd: "D:\\work",
        messages: [{ seq: 0, time: now - 30 * DAY, role: "user", text: "很久以前的一条消息。" }],
      },
      {
        id: "new",
        createdAt: now - DAY,
        cwd: "D:\\work",
        messages: [
          { seq: 0, time: now - DAY, role: "user", text: "第一条较新的消息。" },
          { seq: 1, time: now - DAY + 1, role: "assistant", text: "第二条较新的消息。" },
          { seq: 2, time: now - DAY + 2, role: "user", text: "第三条较新的消息。" },
        ],
      },
    ],
  });
  const corpus = await loadCorpus(service, settings({ lookbackDays: 7, maxDocuments: 2 }), {
    cwd: "D:\\work",
    now,
    refresh: true,
  });
  assert.deepEqual(
    corpus.sessions.map((session) => session.id),
    ["new"],
  );
  assert.equal(corpus.documents.length, 2);
  assert.deepEqual(
    corpus.documents.map((document) => document.seq),
    [1, 2],
  );
  assert.equal(corpusSummary(corpus).documents, 2);
});

test("a second load reuses the cache and refresh rebuilds it", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [
      {
        id: "a",
        createdAt: 1_000,
        cwd: "D:\\work",
        messages: [{ seq: 0, time: 2_000, role: "user", text: "缓存测试用的一条消息。" }],
      },
    ],
  });
  const first = await loadCorpus(service, settings(), { cwd: "D:\\work", now: 5_000 });
  assert.equal(first.fromCache, false);
  const second = await loadCorpus(service, settings(), { cwd: "D:\\work", now: 6_000 });
  assert.equal(second.fromCache, true);
  const listCalls = service.calls.filter((call) => call.method === "listSessions").length;
  assert.equal(listCalls, 1);
  await loadCorpus(service, settings(), { cwd: "D:\\work", now: 7_000, refresh: true });
  assert.equal(service.calls.filter((call) => call.method === "listSessions").length, 2);
});

test("one unreadable session is reported but does not erase the rest", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [
      {
        id: "broken",
        createdAt: 2_000,
        cwd: "D:\\work",
        messages: [{ seq: 0, time: 2_000, role: "user", text: "读失败的一条消息。" }],
      },
      {
        id: "fine",
        createdAt: 1_000,
        cwd: "D:\\work",
        messages: [{ seq: 0, time: 1_000, role: "user", text: "能读的一条消息。" }],
      },
    ],
  });
  // Make the first session fail while listing still advertises it.
  const original = service.readSurface;
  service.readSurface = async (sessionId) => {
    if (sessionId === "broken") throw new Error("simulated read failure");
    return original(sessionId);
  };
  const corpus = await loadCorpus(service, settings(), { cwd: "D:\\work", now: 5_000, refresh: true });
  assert.deepEqual(
    corpus.sessions.map((session) => session.id),
    ["fine"],
  );
  assert.equal(corpus.problems.length, 1);
  assert.match(corpus.problems[0], /simulated read failure/);
});

test("harness injections and reasoning never become corpus text", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [
      {
        id: "mixed",
        createdAt: 1_000,
        cwd: "D:\\work",
        messages: [
          { seq: 0, time: 1_100, role: "user", text: "这是我自己写的一句话。" },
          {
            seq: 1,
            time: 1_200,
            role: "user",
            sourceKind: "runtime-context",
            text: "这是运行时快照注入的上下文，不该进语料。",
          },
          { seq: 2, time: 1_300, role: "assistant", text: "这是模型的回答正文。" },
        ],
      },
    ],
  });
  const corpus = await loadCorpus(service, settings({ minDocumentChars: 4 }), {
    cwd: "D:\\work",
    now: 5_000,
    refresh: true,
  });
  assert.deepEqual(
    corpus.documents.map((document) => document.seq),
    [0, 2],
  );
  assert.ok(corpus.documents.every((document) => !document.text.includes("运行时快照")));
  // The assistant reasoning block is not ordinary text either.
  assert.ok(corpus.documents.every((document) => !document.text.includes("内部推理")));
});

test("a session with nothing corpus-worthy in it is not listed at all", async () => {
  clearCorpusCache();
  const service = fakeSessionQuery({
    sessions: [
      {
        id: "empty",
        createdAt: 3_000,
        cwd: "D:\\work",
        messages: [],
      },
      {
        id: "injected-only",
        createdAt: 2_500,
        cwd: "D:\\work",
        messages: [
          {
            seq: 0,
            time: 2_500,
            role: "user",
            sourceKind: "skill-catalog",
            text: "只有技能目录注入，没有人的话，也没有模型的正文。",
          },
        ],
      },
      {
        id: "real",
        createdAt: 2_000,
        cwd: "D:\\work",
        messages: [{ seq: 0, time: 2_000, role: "user", text: "这一句是真正的人话。" }],
      },
    ],
  });
  const corpus = await loadCorpus(service, settings({ minDocumentChars: 4 }), {
    cwd: "D:\\work",
    now: 5_000,
    refresh: true,
  });
  assert.deepEqual(
    corpus.sessions.map((session) => session.id),
    ["real"],
  );
  assert.equal(corpusSummary(corpus).sessions, 1);
});
