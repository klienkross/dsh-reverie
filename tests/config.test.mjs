/** Config: validation, merge, atomic persistence. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULTS, configPath, coerce, merge, readConfig, runsRoot, writeConfig } from "../lib/config.js";

/**
 * Give one test its own `$DSH_HOME` and restore the previous value afterwards.
 * @param {import("node:test").TestContext} t - current test context.
 * @returns {Promise<string>} the temporary home directory.
 */
async function useHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), "reverie-config-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test("paths follow $DSH_HOME", async (t) => {
  const home = await useHome(t);
  assert.equal(configPath(), path.join(home, "reverie", "config.json"));
  assert.equal(runsRoot(), path.join(home, "reverie", "runs"));
});

test("coerce enforces types, enums and non-negative numbers", () => {
  assert.deepEqual(coerce("maxSessions", 3), { ok: true, value: 3 });
  assert.deepEqual(coerce("maxSessions", -1), { ok: false, reason: "must be a non-negative number" });
  assert.deepEqual(coerce("mode", "live"), { ok: true, value: "live" });
  assert.equal(coerce("mode", "real").ok, false);
  assert.equal(coerce("scope", "everywhere").ok, false);
  assert.equal(coerce("enabled", true).ok, false, "unknown keys are not coerced");
});

test("merge keeps valid fields and reports rejected ones without throwing", () => {
  const { settings, rejected } = merge(DEFAULTS, { mode: "live", maxSteps: 4, nope: 1, scope: "wat" });
  assert.equal(settings.mode, "live");
  assert.equal(settings.maxSteps, 4);
  assert.deepEqual(rejected.map((entry) => entry.key).sort(), ["nope", "scope"]);
});

test("merge validates a sources list and keeps only usable entries", () => {
  const { settings, problems, rejected } = merge(DEFAULTS, {
    sources: [
      { id: "notes", kind: "folder", root: "D:/notes" },
      { id: "bad id", kind: "folder", root: "D:/notes" },
      { id: "rows", kind: "json" },
    ],
  });
  assert.deepEqual(
    settings.sources.map((entry) => entry.id),
    ["notes"],
  );
  assert.equal(problems.length, 2);
  assert.deepEqual(rejected, []);
});

test("merge rejects a non-array sources value", () => {
  const { settings, rejected } = merge(DEFAULTS, { sources: "D:/notes" });
  assert.deepEqual(settings.sources, []);
  assert.ok(rejected.some((entry) => entry.key === "sources"));
});

test("missing config file yields defaults and is not created implicitly", async (t) => {
  await useHome(t);
  const result = await readConfig();
  assert.equal(result.existed, false);
  assert.equal(result.settings.mode, DEFAULTS.mode);
  await assert.rejects(readFile(configPath(), "utf8"));
});

test("write then read round-trips settings", async (t) => {
  await useHome(t);
  await writeConfig({ ...DEFAULTS, mode: "live", maxSteps: 3 });
  const raw = JSON.parse(await readFile(configPath(), "utf8"));
  assert.equal(raw.mode, "live");
  const result = await readConfig();
  assert.equal(result.existed, true);
  assert.equal(result.settings.maxSteps, 3);
});

test("a corrupt config file degrades to defaults and says so", async (t) => {
  await useHome(t);
  await writeConfig({ ...DEFAULTS });
  await writeFile(configPath(), "{not json", "utf8");
  const result = await readConfig();
  assert.equal(result.settings.mode, DEFAULTS.mode);
  assert.ok(result.problems.some((problem) => problem.includes("not valid JSON")));
});
