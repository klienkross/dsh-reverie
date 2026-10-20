/** Source adapters: folder sections, JSON flattening, safety limits. */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createFolderSource, splitSections } from "../lib/sources/folder.js";
import { createJsonSource, flattenRecords } from "../lib/sources/json.js";
import { parseLocator, validateSources } from "../lib/sources/index.js";

/**
 * Create a temporary directory cleaned up by the test.
 * @param {import("node:test").TestContext} t - test context.
 * @param {string} prefix - directory prefix.
 * @returns {Promise<string>} the directory.
 */
async function tempDir(t, prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("splitSections cuts markdown at headings with line ranges", () => {
  const text = "# 一\n\n第一段。\n\n## 二\n\n第二段。";
  const sections = splitSections(text, 4_000);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].start, 1);
  assert.match(sections[0].text, /第一段/);
  assert.equal(sections[1].start, 5);
  assert.match(sections[1].text, /第二段/);
});

test("splitSections chunks an oversized section instead of truncating it", () => {
  const paragraph = "长".repeat(600);
  const sections = splitSections(`# 标题\n\n${paragraph}\n\n${paragraph}`, 800);
  assert.ok(sections.length >= 2);
  assert.ok(sections.every((section) => section.text.length <= 800));
});

test("folder source walks only allowed extensions and skips excluded directories", async (t) => {
  const root = await tempDir(t, "reverie-folder-");
  await writeFile(path.join(root, "note.md"), "# 笔记\n\n这是笔记正文，足够长。", "utf8");
  await writeFile(path.join(root, "skip.png"), "not text", "utf8");
  await mkdir(path.join(root, ".obsidian"));
  await writeFile(path.join(root, ".obsidian", "hidden.md"), "# 隐藏\n\n不该被读到。", "utf8");
  const source = createFolderSource({ id: "notes", kind: "folder", root, extensions: ["md"] });
  const result = await source.load();
  assert.ok(result.documents.length >= 1);
  assert.ok(result.documents.every((document) => document.group.endsWith("note.md")));
  assert.deepEqual(result.problems, []);
  const expanded = await source.read(result.documents[0].locator);
  assert.match(expanded.documents[0].text, /笔记正文/);
});

test("folder source reports a missing root as a problem, not a crash", async () => {
  const source = createFolderSource({ id: "notes", kind: "folder", root: path.join(tmpdir(), "reverie-missing-root") });
  const result = await source.load();
  assert.deepEqual(result.documents, []);
  assert.ok(result.problems[0].includes("does not exist"));
});

test("folder source refuses a locator that escapes the root", async (t) => {
  const root = await tempDir(t, "reverie-escape-");
  const source = createFolderSource({ id: "notes", kind: "folder", root });
  await assert.rejects(source.read("../../etc/passwd#L1-L2"), /escapes the source root|ENOENT/);
});

test("json source flattens arrays, grouped objects and one JSON object per line", async (t) => {
  const root = await tempDir(t, "reverie-json-");
  const arrayFile = path.join(root, "journal.json");
  await writeFile(arrayFile, JSON.stringify([{ text: "第一条", date: "2026-10-01" }, { note: "第二条" }]), "utf8");
  const arraySource = createJsonSource({ id: "journal", kind: "json", path: arrayFile });
  const arrayResult = await arraySource.load();
  assert.equal(arrayResult.documents.length, 2);
  assert.equal(arrayResult.documents[0].locator, `journal.json#0`);
  assert.match(arrayResult.documents[1].text, /第二条/);

  const groupedFile = path.join(root, "grouped.json");
  await writeFile(groupedFile, JSON.stringify({ books: [{ text: "书一" }, { text: "书二" }], films: [{ text: "电影一" }] }), "utf8");
  const grouped = await createJsonSource({ id: "g", kind: "json", path: groupedFile }).load();
  assert.equal(grouped.documents.length, 3);
  assert.ok(grouped.groups.some((group) => group.name === "books"));

  const jsonlFile = path.join(root, "lines.jsonl");
  await writeFile(jsonlFile, ['{"text":"行一"}', "not json", '{"text":"行三"}'].join("\n"), "utf8");
  const jsonl = await createJsonSource({ id: "l", kind: "json", path: jsonlFile }).load();
  assert.equal(jsonl.documents.length, 2);
});

test("json source expands a record locator", async (t) => {
  const root = await tempDir(t, "reverie-json-read-");
  const file = path.join(root, "rows.jsonl");
  await writeFile(file, ['{"text":"甲"}', '{"text":"乙"}'].join("\n"), "utf8");
  const source = createJsonSource({ id: "rows", kind: "json", path: file });
  const loaded = await source.load();
  const expanded = await source.read(loaded.documents[1].locator);
  assert.match(expanded.documents[0].text, /乙/);
});

test("flattenRecords keeps one group per array-valued key", () => {
  const records = flattenRecords({ a: [1, 2], b: { c: 3 } });
  assert.deepEqual(
    records.map((entry) => `${entry.group}:${entry.index}`),
    ["a:0", "a:1"],
  );
});

test("validateSources rejects bad ids, unknown kinds and partial entries", () => {
  const { sources, problems } = validateSources([
    { id: "ok", kind: "folder", root: "/tmp/x" },
    { id: "Bad ID", kind: "folder", root: "/tmp/x" },
    { id: "json", kind: "json" },
    { id: "unknown", kind: "csv" },
    { id: "ok", kind: "folder", root: "/tmp/y" },
  ]);
  assert.deepEqual(
    sources.map((entry) => entry.id),
    ["ok"],
  );
  assert.equal(problems.length, 4);
});

test("parseLocator binds a prefixed locator to its source and a legacy locator to dsh", () => {
  const sources = [
    { id: "notes", kind: "folder" },
    { id: "dsh", kind: "dsh-sessions" },
  ];
  assert.deepEqual(parseLocator("notes/a.md#L1-L2", sources), { sourceId: "notes", inner: "a.md#L1-L2" });
  assert.deepEqual(parseLocator("session-1#96", sources), { sourceId: "dsh", inner: "session-1#96" });
  assert.equal(parseLocator("other/a.md#L1", sources), null);
});
