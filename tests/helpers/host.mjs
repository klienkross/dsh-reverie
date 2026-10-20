/**
 * Minimal host doubles for the plugin tests.
 *
 * These stand in for `ctx.sessionQuery`, `ctx.llm`, and the cordis context so
 * the whole tool surface can be exercised without a running harness. The
 * fakes follow the published contracts closely enough that a shape change in a
 * real call shows up here as a failed assertion rather than a surprise in the
 * host.
 */

/**
 * Build a fake session corpus.
 * @param {{sessions: {id: string, createdAt: number, cwd?: string, parentSession?: string, live?: boolean, persisted?: boolean, origin?: string, messages: {seq: number, time: number, role: 'user'|'assistant', text: string}[]}[]}} input - fixtures.
 * @returns {{listSessions: Function, filterEvents: Function, readEvent: Function, calls: any[]}} the fake service.
 */
export function fakeSessionQuery(input) {
  const sessions = input.sessions.map((session) => ({
    header: {
      version: 4,
      id: session.id,
      createdAt: session.createdAt,
      cwd: session.cwd,
      parentSession: session.parentSession,
      isSeeded: false,
      origin: session.origin,
    },
    live: session.live === true,
    persisted: session.persisted !== false,
    messages: session.messages,
  }));
  const calls = [];
  return {
    calls,
    async listSessions(_signal) {
      calls.push({ method: "listSessions" });
      return sessions.map((session) => ({ header: session.header, live: session.live, persisted: session.persisted }));
    },
    async filterEvents(sessionId, filters) {
      calls.push({ method: "filterEvents", sessionId, filters });
      const session = sessions.find((candidate) => candidate.header.id === sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      if (session.fail) throw new Error("simulated read failure");
      const types = filters?.find((filter) => filter.kind === "type")?.values;
      return session.messages
        .filter((message) => (types ? types.includes(`${message.role}/message`) : true))
        .map((message) => ({
          sessionId,
          seq: message.seq,
          type: `${message.role}/message`,
          time: message.time,
          surface: "current",
          text: message.text,
        }));
    },
    async readEvent(request) {
      calls.push({ method: "readEvent", request });
      const session = sessions.find((candidate) => candidate.header.id === request.sessionId);
      if (!session) throw new Error(`unknown session: ${request.sessionId}`);
      const index = session.messages.findIndex((message) => message.seq === request.seq);
      if (index === -1) throw new Error(`unknown seq: ${request.seq}`);
      const before = request.before ?? 2;
      const after = request.after ?? 2;
      const slice = session.messages.slice(Math.max(0, index - before), index + after + 1);
      const events = slice.map((message) => ({
        seq: message.seq,
        type: `${message.role}/message`,
        time: message.time,
        data:
          message.role === "user"
            ? { content: [{ type: "text", text: message.text }] }
            : { message: { content: [{ type: "text", text: message.text }] } },
      }));
      return {
        session: session.header,
        inheritedEventCount: 0,
        target: events[Math.min(index, events.length - 1)],
        events,
        startSeq: slice[0]?.seq ?? request.seq,
        endSeq: slice[slice.length - 1]?.seq ?? request.seq,
      };
    },
  };
}

/**
 * Build a scripted `ctx.llm` double.
 * @param {{steps: {text?: string, reasoning?: string, toolCalls?: {id: string, name: string, arguments: object}[], usage?: {inputTokens: number, outputTokens: number}, finish?: string}[], fail?: {code: string, message: string}}} script - one entry per model step.
 * @returns {{stream: Function, listProviders: Function, listModels: Function, requests: any[]}} the fake service.
 */
export function fakeLlm(script) {
  const requests = [];
  let step = 0;
  return {
    requests,
    listProviders() {
      return [{ id: "fake-provider", name: "Fake Provider" }];
    },
    async listModels(provider) {
      return [{ provider, id: "fake-model", name: "Fake Model" }];
    },
    async *stream(options) {
      requests.push({
        provider: options.provider,
        model: options.model,
        system: options.system,
        tools: (options.tools ?? []).map((tool) => tool.name),
        maxTokens: options.maxTokens,
        messageCount: options.messages.length,
      });
      const entry = script[step] ?? { finish: "stop" };
      step += 1;
      if (script.fail && step === script.steps.length) {
        yield { type: "finish", reason: { kind: "error", failure: script.fail } };
        return;
      }
      let index = 0;
      if (entry.text) {
        yield { type: "block-start", index, blockType: "text" };
        yield { type: "text-delta", index, text: entry.text };
        yield { type: "block-end", index, block: { type: "text", text: entry.text } };
        index += 1;
      }
      if (entry.reasoning) {
        yield { type: "block-start", index, blockType: "reasoning" };
        yield { type: "reasoning-delta", index, text: entry.reasoning };
        yield { type: "block-end", index, block: { type: "reasoning", text: entry.reasoning } };
        index += 1;
      }
      for (const call of entry.toolCalls ?? []) {
        yield { type: "block-start", index, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.arguments),
        };
        yield {
          type: "block-end",
          index,
          block: { type: "tool-call", id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) },
        };
        index += 1;
      }
      if (entry.usage) yield { type: "usage", usage: entry.usage };
      yield {
        type: "finish",
        reason: { kind: entry.finish ?? ((entry.toolCalls?.length ?? 0) > 0 ? "tool-calls" : "stop") },
      };
    },
  };
}

/**
 * Build a fake cordis context and captured registrations.
 * @param {{llm?: any, sessionQuery?: any, config?: any}} services - injected services.
 * @returns {{ctx: any, tools: any[], sections: any[]}} the context plus captured registrations.
 */
export function fakeCtx(services = {}) {
  const tools = [];
  const sections = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
    llm: services.llm,
    sessionQuery: services.sessionQuery,
  };
  return { ctx, tools, sections };
}

/**
 * Message factory that produces plain objects instead of durable messages.
 * @returns {{user: Function, assistant: Function, toolResult: Function}} the factory.
 */
export function plainMessages() {
  return {
    user({ text }) {
      return { role: "user", content: [{ type: "text", text }], source: { kind: "user" }, id: "m-user" };
    },
    assistant({ blocks, provider, model }) {
      return { role: "assistant", content: blocks, source: { kind: "model", provider, model }, id: "m-assistant" };
    },
    toolResult({ callId, text, isError }) {
      return {
        role: "tool",
        content: [{ type: "text", text }],
        source: { kind: "tool", callId },
        isError,
        id: "m-tool",
      };
    },
  };
}

/**
 * Create one fixture corpus with two sessions and a few messages.
 * @param {string} cwd - working directory the sessions belong to.
 * @returns {ReturnType<typeof fakeSessionQuery>} the fake service.
 */
export function fixtureCorpus(cwd) {
  return fakeSessionQuery({
    sessions: [
      {
        id: "session-alpha",
        createdAt: Date.UTC(2026, 8, 1, 9, 0, 0),
        cwd,
        messages: [
          {
            seq: 0,
            time: Date.UTC(2026, 8, 1, 9, 0, 1),
            role: "user",
            text: "我在想，把记忆当成书架而不是数据库，会不会让检索变得诚实一点。",
          },
          {
            seq: 1,
            time: Date.UTC(2026, 8, 1, 9, 0, 2),
            role: "assistant",
            text: "书架允许一本书被放错位置。数据库不允许。也许错放本身就是一种索引。",
          },
          {
            seq: 2,
            time: Date.UTC(2026, 8, 1, 9, 0, 3),
            role: "user",
            text: "那 Reverie 是不是在书架间走动，而不是在表里查询？它应该允许走神。",
          },
        ],
      },
      {
        id: "session-beta",
        createdAt: Date.UTC(2026, 8, 2, 10, 0, 0),
        cwd,
        messages: [
          {
            seq: 0,
            time: Date.UTC(2026, 8, 2, 10, 0, 1),
            role: "user",
            text: "梦里的房间总是比现实多一扇门，门后是同一个走廊。",
          },
          {
            seq: 1,
            time: Date.UTC(2026, 8, 2, 10, 0, 2),
            role: "assistant",
            text: "多出来的那扇门可能是记忆的压缩产物：走廊被复用了，门是新加的。",
          },
          {
            seq: 2,
            time: Date.UTC(2026, 8, 2, 10, 0, 3),
            role: "user",
            text: "如果把这件事写成一条规则：梦不是随机噪声，而是用很低的成本重放已经存在的结构，那么房间里多出来的门就不神秘了。它只是把我白天走过的那条走廊压得太平，重新展开的时候接口对不齐，于是多出一扇门。这样解释很便宜，但便宜的解释不一定错，只是它没有给我任何新的行动，所以它更像是一个让我停止追问的句号，而不是一个可以继续走的线索。",
          },
        ],
      },
    ],
  });
}
