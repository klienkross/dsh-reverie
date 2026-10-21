/** Mount resilience: one failing part must not take the whole plugin down. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { apply } from "../lib/index.js";
import { clearCorpusCache } from "../lib/corpus.js";
import { fakeLlm, fixtureCorpus } from "./helpers/host.mjs";

/**
 * Give one test its own `$DSH_HOME`.
 * @param {import("node:test").TestContext} t - test context.
 * @returns {Promise<string>} temporary home.
 */
async function useHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), "reverie-resilience-"));
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
 * Build a fake host context whose parts can be made to fail.
 * @param {{tools?: Function, section?: Function, route?: Function}} hooks - failure injectors.
 * @returns {{ctx: any, tools: any[], sections: any[], routes: any[]}} context and captures.
 */
function host(hooks = {}) {
  const tools = [];
  const sections = [];
  const routes = [];
  const ctx = {
    tools: {
      register(tool) {
        if (hooks.tools) hooks.tools(tool);
        tools.push(tool);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        if (hooks.section) hooks.section(section);
        sections.push(section);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        if (hooks.route) hooks.route(route);
        routes.push(route);
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
    llm: fakeLlm([]),
    sessionQuery: fixtureCorpus(process.cwd()),
    get(name) {
      return this[name];
    },
  };
  return { ctx, tools, sections, routes };
}

test("a failing announcement still leaves the tools mounted", async (t) => {
  const home = await useHome(t);
  clearCorpusCache();
  const { ctx, tools, routes } = host({
    section() {
      throw new Error("section service is broken");
    },
  });
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(tools.length, 7);
  assert.equal(routes.length, 4);
  const log = await readFile(path.join(home, "reverie", "apply-error.log"), "utf8");
  assert.match(log, /\[announcement\] section service is broken/);
  assert.match(log, /\[apply-ok\]/);
});

test("a failing route registration does not remove the tools", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const { ctx, tools, sections } = host({
    route() {
      throw new Error("route table is broken");
    },
  });
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(tools.length, 7);
  assert.equal(sections.length, 1);
});

test("a failing tool registration keeps the remaining tools and the announcement", async (t) => {
  const home = await useHome(t);
  clearCorpusCache();
  const { ctx, tools, sections } = host({
    tools(tool) {
      if (tool.name === "reverie_search") throw new Error("duplicate tool");
    },
  });
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(tools.length, 6);
  assert.ok(!tools.some((tool) => tool.name === "reverie_search"));
  assert.equal(sections.length, 1);
  const log = await readFile(path.join(home, "reverie", "apply-error.log"), "utf8");
  assert.match(log, /\[tools-register:reverie_search\] duplicate tool/);
});

test("a mounted plugin records the success marker", async (t) => {
  const home = await useHome(t);
  clearCorpusCache();
  const { ctx } = host();
  apply(ctx, {});
  const log = await readFile(path.join(home, "reverie", "apply-error.log"), "utf8");
  assert.match(log, /\[apply-ok\] ok/);
});

test("disabled plugin mounts nothing and writes no marker", async (t) => {
  const home = await useHome(t);
  clearCorpusCache();
  const { ctx, tools } = host();
  apply(ctx, { enabled: false });
  assert.equal(tools.length, 0);
  await assert.rejects(readFile(path.join(home, "reverie", "apply-error.log"), "utf8"));
});

test("cordis-style contexts resolve optional services only through inject", async (t) => {
  await useHome(t);
  clearCorpusCache();
  const tools = [];
  const sections = [];
  const routes = [];
  const available = {
    llm: fakeLlm([]),
    sessionQuery: fixtureCorpus(process.cwd()),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
  /**
   * Child context that only exposes the services requested by inject.
   * @param {string[]} deps - requested dependencies.
   * @returns {any} scoped context.
   */
  const child = (deps) => {
    const guard = (name) => {
      if (!deps.includes(name)) throw new Error(`cannot get property "${name}" without inject`);
      return available[name];
    };
    return {
      effect: (fn) => fn(),
      get llm() {
        return guard("llm");
      },
      get sessionQuery() {
        return guard("sessionQuery");
      },
      get webServer() {
        return guard("webServer");
      },
    };
  };
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    effect: (fn) => fn(),
    inject(deps, callback) {
      if (!deps.every((dependency) => available[dependency] !== undefined)) return { then() {} };
      callback(child(deps));
      return { then() {} };
    },
  };
  // A direct read of an undeclared service throws, exactly like cordis.
  for (const name of ["llm", "sessionQuery", "webServer"]) {
    Object.defineProperty(ctx, name, {
      get() {
        throw new Error(`cannot get property "${name}" without inject`);
      },
    });
  }

  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(tools.length, 7);
  assert.equal(routes.length, 4);
  assert.equal(sections.length, 1);

  // The injected handles are what the tools actually use.
  const status = tools.find((tool) => tool.name === "reverie_status");
  const value = await status.execute({}, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.equal(value.providerReady, true);
  assert.match(value.providerNote, /fake-provider/);
});
