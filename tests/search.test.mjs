/** Search: tokenizer, ranking, phrase bonus, snippets. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIndex, searchIndex, snippet, tokenize } from "../lib/search.js";

test("tokenize splits latin words and keeps CJK characters and bigrams", () => {
  const tokens = tokenize("Reverie 书架 memory!");
  assert.ok(tokens.includes("reverie"));
  assert.ok(tokens.includes("memory"));
  assert.ok(tokens.includes("书"));
  assert.ok(tokens.includes("书"));
  assert.ok(tokens.includes("书架"));
});

test("tokenize keeps an isolated CJK character as a unigram", () => {
  assert.deepEqual(tokenize("猫"), ["猫"]);
});

test("BM25 ranks the document that contains the query above unrelated noise", () => {
  const index = buildIndex([
    { sessionId: "s1", seq: 0, time: 1, role: "user", text: "书架是一种索引方式，允许错放" },
    { sessionId: "s1", seq: 1, time: 2, role: "assistant", text: "今天晚饭吃了面条，然后洗碗" },
    { sessionId: "s2", seq: 0, time: 3, role: "user", text: "数据库不允许错放，书架允许" },
  ]);
  const { hits, total } = searchIndex(index, "书架 错放", { limit: 5 });
  assert.equal(total, 2);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].score >= hits[1].score);
  assert.deepEqual(hits.map((hit) => index.documents[hit.position].seq).sort(), [0, 0]);
});

test("a literal phrase gets a bonus over the same tokens scattered apart", () => {
  const index = buildIndex([
    { sessionId: "s1", seq: 0, time: 1, role: "user", text: "走廊 门 房间 走廊 门" },
    { sessionId: "s2", seq: 0, time: 2, role: "user", text: "门后的走廊里还有一扇门" },
  ]);
  const { hits } = searchIndex(index, "门后的走廊", { limit: 2 });
  assert.equal(index.documents[hits[0].position].sessionId, "s2");
});

test("an empty or unmatched query returns no hits instead of everything", () => {
  const index = buildIndex([{ sessionId: "s1", seq: 0, time: 1, role: "user", text: "只有这一句" }]);
  assert.equal(searchIndex(index, "", { limit: 3 }).hits.length, 0);
  assert.equal(searchIndex(index, "绝无此词", { limit: 3 }).hits.length, 0);
});

test("snippet centers the excerpt on the first hit and stays bounded", () => {
  const text = `${"前".repeat(200)}关键词${"后".repeat(200)}`;
  const value = snippet(text, ["关键词"], 20);
  assert.ok(value.includes("关键词"));
  assert.ok(value.length <= 20 * 2 + 8);
});

test("indexing an empty corpus is safe", () => {
  const index = buildIndex([]);
  assert.equal(index.size, 0);
  assert.equal(searchIndex(index, "任何", { limit: 3 }).hits.length, 0);
});
