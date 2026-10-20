/** Loop: step assembly, tool dispatch, budgets, error surfacing. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runLoop, streamStep } from "../lib/loop.js";
import { fakeLlm, plainMessages } from "./helpers/host.mjs";

/**
 * Build loop options with one inner echo tool.
 * @param {any} llm - fake llm.
 * @param {{maxSteps?: number, maxInputTokens?: number, timeoutMs?: number, noteLimit?: number}} [budget] - budget overrides.
 * @returns {any} options.
 */
function options(llm, budget = {}) {
  return {
    llm,
    messages: plainMessages(),
    provider: "p",
    model: "m",
    system: "system prompt",
    opening: "opening message",
    tools: [
      {
        name: "echo",
        description: "echo",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        async execute(args) {
          return `echo:${args.value}`;
        },
      },
      {
        name: "reverie_note",
        description: "note",
        parameters: {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
          additionalProperties: false,
        },
        async execute(args, exec) {
          return { type: "reverie-note", note: String(args.note).slice(0, exec.maxNoteChars) };
        },
      },
    ],
    budget: {
      maxSteps: budget.maxSteps ?? 4,
      maxInputTokens: budget.maxInputTokens ?? 100_000,
      maxOutputTokens: 512,
      timeoutMs: budget.timeoutMs ?? 60_000,
      maxNoteChars: budget.noteLimit ?? 2_000,
    },
  };
}

test("a step without tool calls ends the trip as model-ended", async () => {
  const llm = fakeLlm([{ text: "这一趟没有发现。" }]);
  const result = await runLoop(options(llm));
  assert.equal(result.stopReason, "model-ended");
  assert.equal(result.note, "");
  assert.equal(result.usage.steps, 1);
  assert.equal(result.events.at(-1).kind, "settlement");
});

test("tool calls dispatch, results return to the model, and the note is captured", async () => {
  const llm = fakeLlm([
    { reasoning: "先看看", toolCalls: [{ id: "c1", name: "echo", arguments: { value: "hi" } }] },
    { toolCalls: [{ id: "c2", name: "reverie_note", arguments: { note: "纸条正文" } }] },
    { text: "结束。" },
  ]);
  const result = await runLoop(options(llm));
  assert.equal(result.stopReason, "model-ended");
  assert.equal(result.note, "纸条正文");
  assert.equal(result.noteCalls, 1);
  assert.equal(result.usage.steps, 3);
  const toolEvents = result.events.filter((event) => event.kind === "tool");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0].result, "echo:hi");
  assert.deepEqual(llm.requests[0].tools, ["echo", "reverie_note"]);
  // The system prompt rides the first request only.
  assert.equal(llm.requests[0].system, "system prompt");
  assert.equal(llm.requests[1].system, undefined);
  assert.ok(llm.requests[2].messageCount > llm.requests[1].messageCount);
});

test("an unknown tool becomes a visible error result, not a crash", async () => {
  const llm = fakeLlm([{ toolCalls: [{ id: "c1", name: "nope", arguments: {} }] }, { text: "好的。" }]);
  const result = await runLoop(options(llm));
  const failed = result.events.find((event) => event.kind === "tool" && event.isError);
  assert.ok(failed);
  assert.match(failed.result, /unknown tool: nope/);
  assert.equal(result.stopReason, "model-ended");
});

test("invalid JSON arguments become an error result", async () => {
  const llm = fakeLlm([{ text: "unused" }]);
  // Force an unparsable argument string through a custom stream.
  llm.stream = async function* () {
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 0, id: "c1", name: "echo", argumentsDelta: "{broken" };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  };
  const result = await runLoop(options(llm, { maxSteps: 1 }));
  const toolEvents = result.events.filter((event) => event.kind === "tool");
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].isError, true);
  assert.match(toolEvents[0].result, /Error:/);
  assert.equal(result.stopReason, "max-steps");
});

test("a provider error surfaces with its stable code", async () => {
  const llm = fakeLlm([{ text: "unused" }]);
  llm.stream = async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "slow down" } } };
  };
  await assert.rejects(runLoop(options(llm)), (error) => {
    assert.equal(error.code, "RATE_LIMIT");
    assert.match(error.message, /RATE_LIMIT: slow down/);
    return true;
  });
});

test("maxSteps ends the trip as max-steps, not as a model decision", async () => {
  const llm = fakeLlm([
    { toolCalls: [{ id: "c1", name: "echo", arguments: { value: "1" } }] },
    { toolCalls: [{ id: "c2", name: "echo", arguments: { value: "2" } }] },
  ]);
  const result = await runLoop(options(llm, { maxSteps: 2 }));
  assert.equal(result.stopReason, "max-steps");
});

test("the input-token ceiling stops the trip before the next request", async () => {
  const llm = fakeLlm([
    {
      toolCalls: [{ id: "c1", name: "echo", arguments: { value: "1" } }],
      usage: { inputTokens: 500, outputTokens: 10 },
    },
    { text: "第二段", usage: { inputTokens: 500, outputTokens: 10 } },
  ]);
  const result = await runLoop(options(llm, { maxInputTokens: 400 }));
  assert.equal(result.stopReason, "budget");
  assert.equal(llm.requests.length, 1);
});

test("an aborted signal settles as aborted without pretending to finish", async () => {
  const llm = fakeLlm([{ text: "不应被调用" }]);
  const controller = new AbortController();
  controller.abort();
  const result = await runLoop({ ...options(llm), signal: controller.signal });
  assert.equal(result.stopReason, "aborted");
  assert.equal(llm.requests.length, 0);
});

test("streamStep assembles deltas without block-end chunks", async () => {
  const llm = {
    async *stream() {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "你" };
      yield { type: "text-delta", index: 0, text: "好" };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const step = await streamStep(llm, {
    provider: "p",
    model: "m",
    system: "",
    messages: [],
    tools: [],
    maxOutputTokens: 10,
  });
  assert.equal(step.blocks[0].text, "你好");
});
