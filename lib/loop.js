/**
 * The model loop used inside one Reverie run.
 *
 * Reverie owns its own messages: no session is created, nothing is appended to
 * the operator's conversation, and the run can be replayed from its own
 * `events.jsonl`. The loop is deliberately small — stream one step, collect
 * blocks, dispatch the inner tools, repeat until the model stops or a budget
 * ends the trip. Budget exhaustion is reported as its own stop reason instead
 * of being dressed up as the model deciding to finish.
 *
 * @module dsh-reverie/loop
 */

import { estimateTokens, textOfBlocks, truncate } from "./text.js";

/** Maximum characters of one block retained in the run's event log. */
const EVENT_TEXT_LIMIT = 20_000;

/**
 * Incrementally assemble streamed blocks, tolerating adapters that emit only
 * deltas and adapters that emit a final `block-end`.
 * @returns {{start: Function, text: Function, reasoning: Function, toolCall: Function, end: Function, finish: Function}}
 *   the block builder.
 */
export function blockBuilder() {
  /** @type {Map<number, {type: string, text: string, id?: string, name?: string, arguments: string}>} */
  const partial = new Map();
  const order = [];
  const ensure = (index, type) => {
    let entry = partial.get(index);
    if (!entry) {
      entry = { type, text: "", arguments: "" };
      partial.set(index, entry);
      order.push(index);
    }
    return entry;
  };
  return {
    start(index, type) {
      ensure(index, type);
    },
    text(index, delta) {
      ensure(index, "text").text += delta;
    },
    reasoning(index, delta) {
      ensure(index, "reasoning").text += delta;
    },
    toolCall(index, delta) {
      const entry = ensure(index, "tool-call");
      if (delta.id) entry.id = delta.id;
      if (delta.name) entry.name = delta.name;
      if (delta.argumentsDelta) entry.arguments += delta.argumentsDelta;
    },
    end(index, block) {
      if (!block) return;
      partial.set(index, { ...(block ?? {}), type: block.type ?? "text", text: block.text ?? "" });
      if (!order.includes(index)) order.push(index);
    },
    finish() {
      const blocks = [];
      for (const index of order.slice().sort((left, right) => left - right)) {
        const entry = partial.get(index);
        if (!entry) continue;
        if (entry.type === "text") {
          if (entry.text.trim() !== "") blocks.push({ type: "text", text: entry.text });
        } else if (entry.type === "reasoning") {
          if (entry.text !== "") blocks.push({ type: "reasoning", text: entry.text });
        } else if (entry.type === "tool-call") {
          blocks.push({
            type: "tool-call",
            id: entry.id ?? `call-${index}`,
            name: entry.name ?? "",
            arguments: entry.arguments ?? "",
          });
        } else {
          blocks.push(entry);
        }
      }
      return blocks;
    },
  };
}

/**
 * Stream exactly one model step.
 * @param {{stream: Function}} llm - host `ctx.llm` service.
 * @param {{provider: string, model: string, system: string, messages: any[], tools: any[], maxOutputTokens: number, reasoningEffort?: string, signal?: AbortSignal}} request - one request.
 * @returns {Promise<{blocks: any[], usage: any, finish: any}>} the assembled step.
 */
export async function streamStep(llm, request) {
  const builder = blockBuilder();
  let usage = null;
  let finish = null;
  const options = {
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    maxTokens: request.maxOutputTokens,
    signal: request.signal,
  };
  if (request.system) options.system = request.system;
  if (request.reasoningEffort) options.reasoningEffort = request.reasoningEffort;
  for await (const chunk of llm.stream(options)) {
    switch (chunk.type) {
      case "block-start":
        builder.start(chunk.index, chunk.blockType);
        break;
      case "text-delta":
        builder.text(chunk.index, chunk.text);
        break;
      case "reasoning-delta":
        builder.reasoning(chunk.index, chunk.text);
        break;
      case "tool-call-delta":
        builder.toolCall(chunk.index, chunk);
        break;
      case "block-end":
        builder.end(chunk.index, chunk.block);
        break;
      case "usage":
        usage = chunk.usage;
        break;
      case "finish":
        finish = chunk.reason;
        break;
      default:
        break;
    }
  }
  return { blocks: builder.finish(), usage, finish };
}

/**
 * Describe a terminal finish reason as a stable lowercase token.
 * @param {any} finish - `FinishReason` from the stream.
 * @returns {string} `stop`, `tool-calls`, `max-tokens`, `error`, `aborted`, or the raw kind.
 */
export function finishKind(finish) {
  const kind = finish?.kind;
  if (typeof kind !== "string") return "unknown";
  return kind;
}

/**
 * Run one Reverie trip to settlement.
 *
 * @param {object} options - run inputs.
 * @param {{stream: Function}} options.llm - host `ctx.llm`.
 * @param {{user: Function, assistant: Function, toolResult: Function}} options.messages - durable message constructors.
 * @param {string} options.provider - provider route.
 * @param {string} options.model - model id.
 * @param {string} options.system - system prompt.
 * @param {string} options.opening - first user message.
 * @param {{name: string, description: string, parameters: object, execute: Function}[]} options.tools - inner tools.
 * @param {{maxSteps: number, maxInputTokens: number, maxOutputTokens: number, timeoutMs: number, maxNoteChars: number, reasoningEffort?: string}} options.budget - run budget.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {(event: any) => void} [options.onEvent] - live event observer (also the log source).
 * @returns {Promise<{messages: any[], events: any[], stopReason: string, usage: {input: number, output: number, total: number, steps: number}, note: string, noteCalls: number, startedAt: number, endedAt: number}>}
 *   the settled run.
 */
export async function runLoop(options) {
  const startedAt = Date.now();
  const deadline = startedAt + options.budget.timeoutMs;
  const events = [];
  const emit = (event) => {
    events.push(event);
    options.onEvent?.(event);
  };
  const messages = [options.messages.user({ text: options.opening })];
  const usage = { input: 0, output: 0, total: 0, steps: 0 };
  const schemas = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  let stopReason = "unknown";
  let note = "";
  let noteCalls = 0;
  let blockedTokens = 0;

  for (let step = 1; step <= options.budget.maxSteps; step += 1) {
    if (options.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    if (Date.now() > deadline) {
      stopReason = "timeout";
      break;
    }
    const stepStartedAt = Date.now();
    const outcome = await streamStep(options.llm, {
      provider: options.provider,
      model: options.model,
      system: step === 1 ? options.system : undefined,
      messages,
      tools: schemas,
      maxOutputTokens: options.budget.maxOutputTokens,
      reasoningEffort: options.budget.reasoningEffort,
      signal: options.signal,
    });
    const kind = finishKind(outcome.finish);
    const text = textOfBlocks(outcome.blocks);
    const assistant = options.messages.assistant({
      blocks: outcome.blocks,
      provider: options.provider,
      model: options.model,
    });
    messages.push(assistant);
    usage.steps = step;
    if (outcome.usage) {
      usage.input += outcome.usage.inputTokens ?? 0;
      usage.output += outcome.usage.outputTokens ?? 0;
      usage.total += outcome.usage.totalTokens ?? (outcome.usage.inputTokens ?? 0) + (outcome.usage.outputTokens ?? 0);
    } else {
      // No provider accounting: fall back to a conservative estimate so the
      // ceiling still bounds the trip instead of evaporating.
      usage.input += estimateTokens(JSON.stringify(messages));
      usage.output += estimateTokens(text);
      usage.total = usage.input + usage.output;
    }
    const toolCalls = outcome.blocks.filter((block) => block.type === "tool-call");
    emit({
      step,
      kind: "assistant",
      at: stepStartedAt,
      ms: Date.now() - stepStartedAt,
      finish: kind,
      text: truncate(text, EVENT_TEXT_LIMIT),
      reasoning: truncate(
        outcome.blocks
          .filter((block) => block.type === "reasoning")
          .map((block) => block.text)
          .join("\n"),
        EVENT_TEXT_LIMIT,
      ),
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: truncate(call.arguments ?? "", 4_000),
      })),
      usage: outcome.usage ?? null,
    });

    if (kind === "error") {
      const failure = outcome.finish?.failure;
      const code = failure?.code ?? "LLM_ERROR";
      const message = failure?.message ?? "model stream failed";
      throw Object.assign(new Error(`${code}: ${message}`), { code });
    }
    if (kind === "aborted") {
      stopReason = "aborted";
      break;
    }
    if (toolCalls.length === 0) {
      stopReason = kind === "max-tokens" ? "max-tokens" : "model-ended";
      break;
    }
    for (const call of toolCalls) {
      if (options.signal?.aborted) break;
      const tool = options.tools.find((candidate) => candidate.name === call.name);
      let value;
      let isError = false;
      try {
        if (!tool) throw new Error(`unknown tool: ${call.name}`);
        const parsed = call.arguments === "" ? {} : JSON.parse(call.arguments);
        value = await tool.execute(parsed, { signal: options.signal, maxNoteChars: options.budget.maxNoteChars });
        if (typeof value === "object" && value !== null && value.type === "reverie-note") {
          note = value.note;
          noteCalls += 1;
        }
      } catch (error) {
        isError = true;
        value = { error: error instanceof Error ? error.message : String(error) };
      }
      const rendered = isError
        ? `Error: ${/** @type {{error: string}} */ (value).error}`
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
      messages.push(options.messages.toolResult({ callId: call.id, text: rendered, isError }));
      emit({
        step,
        kind: "tool",
        at: Date.now(),
        callId: call.id,
        name: call.name,
        arguments: truncate(call.arguments ?? "", 4_000),
        isError,
        result: truncate(rendered, EVENT_TEXT_LIMIT),
      });
    }
    if (options.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    if (usage.input > options.budget.maxInputTokens) {
      // Stop before the next request: the ceiling bounds spend, not history.
      blockedTokens = usage.input;
      stopReason = "budget";
      break;
    }
    if (step === options.budget.maxSteps) stopReason = "max-steps";
  }

  // A trip that ran out of steps while still reading would otherwise end with
  // no note at all. One dedicated finalize request — only the note tool, one
  // small step — turns the trail into the artifact the run exists to produce.
  if (note === "" && stopReason !== "aborted") {
    const final = await finalizeNote(options, messages, usage, deadline);
    if (final.note !== "") {
      note = final.note;
      noteCalls += 1;
      emit({
        step: usage.steps,
        kind: "finalize",
        at: Date.now(),
        noteChars: note.length,
        after: stopReason,
      });
    }
  }

  const endedAt = Date.now();
  emit({
    step: usage.steps,
    kind: "settlement",
    at: endedAt,
    stopReason,
    noteCalls,
    blockedTokens,
    usage: { input: usage.input, output: usage.output, total: usage.total },
  });
  return { messages, events, stopReason, usage, note, noteCalls, startedAt, endedAt };
}

/** Instruction used for the one forced finalize step. */
const FINALIZE_NUDGE = [
  "步骤预算已经用完，但这一趟还没有写下私人纸条。",
  "现在不要继续检索，不要再展开原文：只根据上面已经读到的内容，调用一次 `reverie_note` 写下纸条。",
  "纸条要包含：主题、你实际看到的东西、能引用的 locator、还没解决的、这趟值不值。",
  "如果这趟确实什么都没有发现，就如实说没有发现。",
  "除 `reverie_note` 之外的任何工具调用都会被拒绝。",
].join("\n");

/**
 * Run the single forced finalize step.
 *
 * Exposed for tests; the main loop calls it only when a trip ended without a
 * note. It is deliberately one small step with one available tool: no search,
 * no read, no way to keep exploring.
 * @param {any} options - the same run options passed to {@link runLoop}.
 * @param {any[]} messages - the settled conversation.
 * @param {{input: number, output: number, total: number, steps: number}} usage - running totals, updated in place.
 * @param {number} deadline - wall-clock ceiling of the whole run.
 * @returns {Promise<{note: string}>} the note, or an empty string when the model still refused.
 */
export async function finalizeNote(options, messages, usage, deadline) {
  const noteTool = options.tools.find((tool) => tool.name === "reverie_note");
  if (!noteTool) return { note: "" };
  if (options.signal?.aborted || Date.now() > deadline) return { note: "" };
  const finalMessages = [...messages, options.messages.user({ text: FINALIZE_NUDGE })];
  const blocks = [];
  const builder = blockBuilder();
  let finish = null;
  try {
    for await (const chunk of options.llm.stream({
      provider: options.provider,
      model: options.model,
      messages: finalMessages,
      tools: [{ name: noteTool.name, description: noteTool.description, parameters: noteTool.parameters }],
      maxTokens: Math.min(1_024, options.budget.maxOutputTokens),
      signal: options.signal,
    })) {
      switch (chunk.type) {
        case "block-start":
          builder.start(chunk.index, chunk.blockType);
          break;
        case "text-delta":
          builder.text(chunk.index, chunk.text);
          break;
        case "reasoning-delta":
          builder.reasoning(chunk.index, chunk.text);
          break;
        case "tool-call-delta":
          builder.toolCall(chunk.index, chunk);
          break;
        case "block-end":
          builder.end(chunk.index, chunk.block);
          break;
        case "usage":
          usage.input += chunk.usage?.inputTokens ?? 0;
          usage.output += chunk.usage?.outputTokens ?? 0;
          usage.total += chunk.usage?.totalTokens ?? (chunk.usage?.inputTokens ?? 0) + (chunk.usage?.outputTokens ?? 0);
          break;
        case "finish":
          finish = chunk.reason;
          break;
        default:
          break;
      }
    }
  } catch {
    return { note: "" };
  }
  blocks.push(...builder.finish());
  usage.steps += 1;
  if (finishKind(finish) === "error" || finishKind(finish) === "aborted") return { note: "" };
  const call = blocks.find((block) => block.type === "tool-call" && block.name === "reverie_note");
  if (!call) return { note: "" };
  try {
    const parsed = call.arguments === "" ? {} : JSON.parse(call.arguments);
    const value = await noteTool.execute(parsed, { signal: options.signal, maxNoteChars: options.budget.maxNoteChars });
    if (typeof value === "object" && value !== null && value.type === "reverie-note") return { note: value.note };
  } catch {
    return { note: "" };
  }
  return { note: "" };
}
