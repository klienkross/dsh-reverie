/** The web client bundle: module-loader shape, exports, slot registration. */

import assert from "node:assert/strict";
import { test } from "node:test";

/** Captured ModuleLoader entry, filled when the bundle is imported below. */
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};

/** Minimal react stand-in: the bundle only needs createElement at registration. */
const fakeReact = {
  createElement: (...args) => ({ kind: "element", args }),
  useState: (value) => [value, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
};

const loaded = import("../lib/client.js");

test("the client bundle registers as a module-loader plugin", async () => {
  await loaded;
  assert.equal(captured.id, "@kleinkross/dsh-reverie");
  assert.equal(typeof captured.factory, "function");
  const module = captured.factory((name) => {
    if (name === "react") return fakeReact;
    throw new Error(`unexpected require: ${name}`);
  });
  assert.equal(typeof module.apply, "function");
  assert.deepEqual(module.inject, ["slots"]);
  assert.equal(typeof module.ReveriePanel, "function");
});

test("apply registers one settings section labelled Reverie", async () => {
  await loaded;
  const module = captured.factory((name) => {
    if (name === "react") return fakeReact;
    throw new Error(`unexpected require: ${name}`);
  });
  const registered = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        assert.equal(name, "settings.section");
        callback();
      },
      register(meta, component) {
        registered.push({ meta, component });
      },
    },
  };
  module.apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].meta.name, "settings.section");
  assert.equal(registered[0].meta.id, "reverie");
  assert.equal(registered[0].meta.label(), "Reverie");
  assert.equal(typeof registered[0].component, "function");
});

test("a broken slots service never throws out of apply", async () => {
  await loaded;
  const module = captured.factory((name) => {
    if (name === "react") return fakeReact;
    throw new Error(`unexpected require: ${name}`);
  });
  const ctx = {
    slots: {
      inject() {
        throw new Error("no slots here");
      },
      register() {},
    },
  };
  assert.doesNotThrow(() => module.apply(ctx));
});
