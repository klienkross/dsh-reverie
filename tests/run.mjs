/**
 * In-process test runner.
 *
 * `node --test tests/` spawns one child per file; that is the normal way to run
 * a node:test suite, but it needs unrestricted process spawning. This runner
 * imports the same files into one process, which keeps the suite runnable in
 * confined sandboxes and CI images where child processes are restricted.
 *
 * `npm run test:isolated` uses the per-file runner when spawning is available.
 */

import "./config.test.mjs";
import "./corpus.test.mjs";
import "./loop.test.mjs";
import "./mock.test.mjs";
import "./plugin.test.mjs";
import "./search.test.mjs";
