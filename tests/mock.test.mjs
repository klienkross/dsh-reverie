/** Mock trip: deterministic, honest about being a mock, evidence stays locatable. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex } from "../lib/search.js";
import { runMock } from "../lib/mock.js";

/**
 * Build a small deterministic corpus.
 * @returns {any[]} documents.
 */
function documents() {
  return [
    {
      locator: "notes/书架.md#L1-L3",
      sourceId: "notes",
      sourceKind: "folder",
      kind: "note",
      time: Date.UTC(2026, 8, 1),
      text: "我在想，把记忆当成书架而不是数据库，会不会让检索变得诚实一点。书架允许书被放错位置，数据库不允许；错放也许本身就是一种索引。",
    },
    {
      locator: "dsh/session-beta#1",
      sourceId: "dsh",
      sourceKind: "dsh-sessions",
      kind: "reply",
      time: Date.UTC(2026, 8, 2),
      text: "书架允许一本书被放错位置，数据库不允许；也许错放本身就是一种索引，只是我们没有为它写查询语句，于是它只能以偶然的方式被读到。",
    },
    {
      locator: "journal/entries#2",
      sourceId: "journal",
      sourceKind: "json",
      kind: "row",
      time: Date.UTC(2026, 8, 3),
      text: "梦里的走廊被复用了，门是新加的；压缩和展开的接口对不齐，就多出一扇门。",
    },
  ];
}

test("a mock trip is deterministic and says no model was called", () => {
  const corpus = documents();
  const index = buildIndex(corpus);
  const first = runMock({ index, documents: corpus, language: "zh", maxNoteChars: 2_000 });
  const second = runMock({ index, documents: corpus, language: "zh", maxNoteChars: 2_000 });
  assert.equal(first.note, second.note);
  assert.match(first.note, /mock/);
  assert.match(first.note, /reverie_search|词法/);
  assert.equal(first.stopReason, "mock-ended");
  assert.equal(first.usage.steps, 1);
  assert.ok(first.note.length <= 2_000);
});

test("a mock trip leaves only locators that exist in the corpus", () => {
  const corpus = documents();
  const index = buildIndex(corpus);
  const result = runMock({ index, documents: corpus, language: "zh", maxNoteChars: 2_000 });
  const known = new Set(corpus.map((document) => document.locator));
  const locators = [...result.note.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((value) => known.has(value));
  assert.ok(locators.length > 0);
  for (const locator of locators) {
    assert.ok(known.has(locator), `locator ${locator} must exist`);
  }
});

test("an empty or too-short corpus produces an explicit empty-corpus result", () => {
  const corpus = [{ locator: "notes/a.md#L1-L1", text: "短", time: 1 }];
  const index = buildIndex(corpus);
  const result = runMock({ index, documents: corpus, language: "zh", maxNoteChars: 2_000 });
  assert.equal(result.stopReason, "empty-corpus");
  assert.equal(result.seeds.length, 0);
});

test("the note is bounded by maxNoteChars", () => {
  const corpus = documents();
  const index = buildIndex(corpus);
  const result = runMock({ index, documents: corpus, language: "zh", maxNoteChars: 80 });
  assert.ok(result.note.length <= 80);
});
