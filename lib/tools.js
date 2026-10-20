/**
 * The model-facing tool surface.
 *
 * Seven tools, all host-side:
 *   reverie_status    what the plugin can see and how it is configured
 *   reverie_sessions  the corpus sessions one run would read
 *   reverie_search    ranked evidence with `<sessionId>#<seq>` locators
 *   reverie_read      expand one locator into the exact original window
 *   reverie_run       one bounded mock or live trip, writing run artifacts
 *   reverie_report    read back a run's report / note / trail
 *   reverie_config    inspect or change the runtime settings
 *
 * Every tool returns a canonical value and renders the model-facing text from
 * it, so the structured value stays inspectable by a UI while the model reads
 * the same story a human would.
 *
 * @module dsh-reverie/tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import path from "node:path";

import { DEFAULTS, merge, readConfig, reverieRoot, runsRoot, writeConfig } from "./config.js";
import { clearCorpusCache, corpusSummary, loadCorpus } from "./corpus.js";
import { buildIndex, searchIndex } from "./search.js";
import { openingMessage, systemPrompt } from "./prompt.js";
import { runLoop } from "./loop.js";
import { runMock } from "./mock.js";
import { randomSuffix, runId, writeRun } from "./artifacts.js";
import { listRuns, latestNote, readRunFile } from "./runs.js";
import { clampInt, dayKey, eventText, isoTime, oneLine, truncate } from "./text.js";

/** Maximum characters of a run report handed back to the model in one call. */
const REPORT_LIMIT = 12_000;

/**
 * Build one model-facing text block list.
 * @param {string} text - model-facing text.
 * @returns {{type: "text", text: string}[]} content blocks.
 */
function textBlocks(text) {
  return [{ type: "text", text }];
}

/** Shared renderer: the canonical value's `message` is what the model reads. */
function renderMessage(_args, value) {
  return textBlocks(String(value?.message ?? ""));
}

/**
 * Declare an object-rooted output with a message renderer.
 * @param {Record<string, any>} properties - value schema properties.
 * @returns {{schema: any, render: Function}} output declaration.
 */
function objectOutput(properties) {
  return {
    schema: { type: "object", additionalProperties: false, properties },
    render: renderMessage,
  };
}

/**
 * Resolve the workspace directory of the calling agent, if it has one.
 * @param {any} exec - tool run context.
 * @returns {string | undefined} absolute directory.
 */
function callDirectory(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/**
 * Find the provider/model a live run should use.
 * @param {any} ctx - host context.
 * @param {Record<string, any>} settings - effective settings.
 * @returns {Promise<{ok: true, provider: string, model: string, providers: string[]} | {ok: false, reason: string, providers: string[]}>}
 *   the resolved route, or why it cannot be resolved.
 */
export async function resolveRoute(ctx, settings) {
  const providers = ctx.llm?.listProviders?.() ?? [];
  const ids = providers.map((entry) => entry.id);
  if (ids.length === 0) {
    return { ok: false, reason: "no provider adapter is registered in this host", providers: ids };
  }
  const provider = settings.provider !== "" ? settings.provider : ids[0];
  if (!ids.includes(provider)) {
    return {
      ok: false,
      reason: `provider \`${provider}\` is not registered (available: ${ids.join(", ")})`,
      providers: ids,
    };
  }
  let model = settings.model;
  if (model === "") {
    const models = (await ctx.llm.listModels?.(provider)) ?? [];
    model = models[0]?.id ?? "";
    if (model === "") return { ok: false, reason: `provider \`${provider}\` advertises no model`, providers: ids };
  }
  return { ok: true, provider, model, providers: ids };
}

/** Last built index, keyed by the corpus snapshot it came from. */
let indexCache = { key: "", index: null };

/**
 * Build a ranked index once per corpus snapshot.
 * @param {any} corpus - loaded corpus carrying its cache `key`.
 * @returns {any} its search index.
 */
function indexFor(corpus) {
  const key = String(corpus.key ?? corpus.builtAt);
  if (indexCache.key !== key || indexCache.index === null) {
    indexCache = { key, index: buildIndex(corpus.documents) };
  }
  return indexCache.index;
}

/**
 * Load the corpus for one tool call, keeping failures visible.
 * @param {any} state - plugin state.
 * @param {any} exec - tool run context.
 * @param {{refresh?: boolean, settings?: Record<string, any>}} [options] - call options.
 * @returns {Promise<{ok: true, corpus: any, settings: Record<string, any>} | {ok: false, message: string}>} result.
 */
async function loadForCall(state, exec, options = {}) {
  const { settings, problems } = await readConfig();
  if (!state.ctx.sessionQuery) {
    return { ok: false, message: "sessionQuery is not available in this host; Reverie needs it to read the corpus." };
  }
  const cwd = callDirectory(exec) ?? process.cwd();
  const corpus = await loadCorpus(state.ctx.sessionQuery, options.settings ?? settings, {
    cwd,
    refresh: options.refresh === true,
    signal: exec?.signal,
  });
  const notes = [...problems, ...corpus.problems];
  if (corpus.documents.length === 0) {
    const hint =
      settings.scope === "workspace"
        ? "No persisted session in this workspace has messages yet. Widen `scope` to `all` in reverie_config, or start a session in a workspace with history."
        : "No persisted sessions are readable. Check ~/.dsh/sessions and the host's persistence backend.";
    return {
      ok: false,
      message: `Reverie has no corpus to read. ${hint}${notes.length > 0 ? `\n\nWarnings:\n- ${notes.join("\n- ")}` : ""}`,
    };
  }
  return { ok: true, corpus: { ...corpus, problems: notes }, settings };
}

/**
 * Render one corpus session line.
 * @param {any} session - session summary.
 * @returns {string} one line.
 */
function sessionLine(session) {
  const span =
    session.firstTime === null ? "no messages" : `${isoTime(session.firstTime)} → ${isoTime(session.lastTime)}`;
  return `- \`${session.id}\` · ${isoTime(session.createdAt)} · ${session.documents}/${session.messages} 条 · ${span} · ${session.cwd || "(no cwd)"}`;
}

/**
 * Tool: plugin + corpus + route status.
 * @param {any} state - plugin state.
 * @returns {any} tool definition.
 */
function statusTool(state) {
  return defineTool({
    name: "reverie_status",
    description:
      "查看 dsh-reverie 状态：运行配置（mode/scope/provider/model/预算）、本工作区可读语料的会话与消息统计、模型线路是否可用、最近一次运行。不改动任何数据。",
    parameters: {},
    output: objectOutput({
      ok: { type: "boolean" },
      message: { type: "string" },
      root: { type: "string" },
      configPath: { type: "string" },
      configProblems: { type: "array", items: { type: "string" } },
      mode: { type: "string" },
      scope: { type: "string" },
      sessions: { type: "number" },
      documents: { type: "number" },
      oldest: { type: "string" },
      newest: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      providerReady: { type: "boolean" },
      providerNote: { type: "string" },
      lastRun: { type: "string" },
    }),
    async execute(_args, exec) {
      const { settings, problems, path } = await readConfig();
      const root = reverieRoot();
      let corpusLine = "语料：不可用（host 未提供 sessionQuery）";
      let stats = { documents: 0, sessions: 0 };
      let oldest = "";
      let newest = "";
      let corpusProblems = [];
      if (state.ctx.sessionQuery) {
        try {
          const cwd = callDirectory(exec) ?? process.cwd();
          const corpus = await loadCorpus(state.ctx.sessionQuery, settings, { cwd, signal: exec.signal });
          const summary = corpusSummary(corpus);
          stats = { documents: summary.documents, sessions: summary.sessions };
          oldest = summary.oldest === null ? "" : isoTime(summary.oldest);
          newest = summary.newest === null ? "" : isoTime(summary.newest);
          corpusProblems = [...problems, ...corpus.problems];
          corpusLine =
            summary.documents === 0
              ? "语料：0 条消息（scope 内没有已持久化会话）"
              : `语料：${summary.sessions} 个会话 / ${summary.documents} 条消息 · ${oldest} → ${newest}`;
        } catch (error) {
          corpusProblems = [...problems, error instanceof Error ? error.message : String(error)];
          corpusLine = `语料：读取失败 —— ${corpusProblems[corpusProblems.length - 1]}`;
        }
      }
      let providerReady = false;
      let providerNote = "未检查";
      if (state.ctx.llm) {
        const route = await resolveRoute(state.ctx, settings).catch((error) => ({ ok: false, reason: String(error) }));
        providerReady = route.ok;
        providerNote = route.ok ? `${route.provider} / ${route.model}` : route.reason;
      }
      const runs = await listRuns(runsRoot(), 1).catch(() => []);
      const last = runs[0];
      const lastRun = last
        ? `${last.runId} · ${last.mode} · ${last.stopReason} · ${last.endedAt}`
        : "（还没有运行记录）";
      const message = [
        "dsh-reverie",
        corpusLine,
        `配置：${path}`,
        `运行方式：${settings.mode}${settings.mode === "mock" ? "（不调用模型）" : "（真实模型，会产生费用）"}`,
        `语料范围：${settings.scope} · 最多 ${settings.maxSessions} 个会话 / ${settings.maxDocuments} 条消息`,
        `模型线路：${providerReady ? providerNote : `不可用 —— ${providerNote}`}`,
        `预算：${settings.maxSteps} 步 · 输入上限 ${settings.maxInputTokens} tokens · 单步输出 ${settings.maxOutputTokens} tokens · 超时 ${settings.timeoutMs}ms`,
        `最近运行：${lastRun}`,
        `产物目录：${runsRoot()}`,
        corpusProblems.length > 0 ? `\n警告：\n- ${corpusProblems.join("\n- ")}` : "",
      ]
        .join("\n")
        .trim();
      return {
        ok: true,
        message,
        root,
        configPath: path,
        configProblems: problems,
        mode: String(settings.mode),
        scope: String(settings.scope),
        sessions: stats.sessions,
        documents: stats.documents,
        oldest,
        newest,
        provider: settings.provider,
        model: settings.model,
        providerReady,
        providerNote,
        lastRun,
      };
    },
  });
}

/**
 * Tool: list the corpus sessions.
 * @param {any} state - plugin state.
 * @returns {any} tool definition.
 */
function sessionsTool(state) {
  return defineTool({
    name: "reverie_sessions",
    description:
      "列出 Reverie 会读到的语料会话（仅已持久化、非当前活跃会话），含创建时间、消息数、时间跨度与工作目录。默认按最新排序，最多 50 条。",
    parameters: {
      limit: { type: "number", description: "条数上限（默认 20，最大 50）" },
      refresh: { type: "boolean", description: "忽略 10 分钟语料缓存，重新读取（默认 false）" },
    },
    output: objectOutput({
      ok: { type: "boolean" },
      message: { type: "string" },
      sessions: { type: "number" },
      documents: { type: "number" },
      items: { type: "array", items: { type: "string" } },
      problems: { type: "array", items: { type: "string" } },
    }),
    async execute(args, exec) {
      const loaded = await loadForCall(state, exec, { refresh: args.refresh === true });
      if (!loaded.ok) return { ok: false, message: loaded.message };
      const limit = clampInt(args.limit, 20, 1, 50);
      const sessions = loaded.corpus.sessions.slice(0, limit);
      const summary = corpusSummary(loaded.corpus);
      const lines = sessions.map(sessionLine);
      const message = [
        `语料：${summary.sessions} 个会话 / ${summary.documents} 条消息（scope \`${loaded.settings.scope}\`）`,
        "",
        ...lines,
        sessions.length < summary.sessions
          ? `\n… 还有 ${summary.sessions - sessions.length} 个会话未列出（调大 limit）`
          : "",
        loaded.corpus.problems.length > 0 ? `\n警告：\n- ${loaded.corpus.problems.join("\n- ")}` : "",
      ]
        .join("\n")
        .trim();
      return {
        ok: true,
        message,
        sessions: summary.sessions,
        documents: summary.documents,
        items: lines,
        problems: loaded.corpus.problems,
      };
    },
  });
}

/**
 * Tool: ranked evidence search.
 * @param {any} state - plugin state.
 * @returns {any} tool definition.
 */
function searchTool(state) {
  return defineTool({
    name: "reverie_search",
    description:
      "在本机只读语料里做词法检索（BM25 + 短语加权，支持中文二元切词），返回带 locator（`<sessionId>#<seq>`）的证据片段。语料只读，不写回任何记忆。",
    parameters: {
      query: { type: "string", required: true, description: "检索词或短语；按字面处理，不是查询语法" },
      limit: { type: "number", description: "条数（默认 8，最大 20）" },
      sessionId: { type: "string", description: "只在这个会话内检索" },
      role: { type: "string", enum: ["user", "assistant"], description: "只看某一方说的话" },
    },
    output: objectOutput({
      ok: { type: "boolean" },
      message: { type: "string" },
      total: { type: "number" },
      hits: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            locator: { type: "string" },
            sessionId: { type: "string" },
            seq: { type: "number" },
            role: { type: "string" },
            time: { type: "string" },
            score: { type: "number" },
            snippet: { type: "string" },
          },
        },
      },
    }),
    async execute(args, exec) {
      const query = String(args.query ?? "").trim();
      if (query === "") return { ok: false, message: "query 不能为空。" };
      const loaded = await loadForCall(state, exec);
      if (!loaded.ok) return { ok: false, message: loaded.message };
      const index = indexFor(loaded.corpus);
      const { hits, total } = searchIndex(index, query, { limit: clampInt(args.limit, 8, 1, 20) });
      const filtered = hits
        .map((hit) => ({
          hit,
          document: loaded.corpus.documents[hit.position],
        }))
        .filter(({ document }) => {
          if (typeof args.sessionId === "string" && args.sessionId !== "" && document.sessionId !== args.sessionId)
            return false;
          if (typeof args.role === "string" && args.role !== "" && document.role !== args.role) return false;
          return true;
        });
      if (filtered.length === 0) {
        return {
          ok: true,
          message: `\`${query}\` 在语料里没有可用命中。语料 ${loaded.corpus.documents.length} 条消息；换一个词、减少过滤条件，或用 reverie_sessions 看看有哪些会话。`,
          total,
          hits: [],
        };
      }
      const lines = filtered.map(({ hit, document }, position) => {
        return `${position + 1}. \`${document.sessionId}#${document.seq}\` · ${document.role} · ${isoTime(document.time)} · score ${hit.score.toFixed(2)}\n   ${oneLine(hit.snippet, 400)}`;
      });
      return {
        ok: true,
        message: [`命中 ${total} 条，返回 ${filtered.length} 条：`, "", ...lines].join("\n"),
        total,
        hits: filtered.map(({ hit, document }) => ({
          locator: `${document.sessionId}#${document.seq}`,
          sessionId: document.sessionId,
          seq: document.seq,
          role: document.role,
          time: isoTime(document.time),
          score: Number(hit.score.toFixed(3)),
          snippet: oneLine(hit.snippet, 400),
        })),
      };
    },
  });
}

/**
 * Tool: expand one locator into its original event window.
 * @param {any} state - plugin state.
 * @returns {any} tool definition.
 */
function readTool(state) {
  return defineTool({
    name: "reverie_read",
    description:
      "按 locator（`<sessionId>#<seq>`）展开原文：返回该事件以及前后若干条事件的完整文本。这是把摘要变成证据的唯一方式；读不到就明确失败，不猜。",
    parameters: {
      sessionId: { type: "string", required: true, description: "会话 id（来自 reverie_search 的 locator）" },
      seq: { type: "number", required: true, description: "事件 seq（来自 locator）" },
      before: { type: "number", description: "向前包含多少条（默认 2，最大 20）" },
      after: { type: "number", description: "向后包含多少条（默认 2，最大 20）" },
    },
    output: objectOutput({
      ok: { type: "boolean" },
      message: { type: "string" },
      events: { type: "array", items: { type: "string" } },
    }),
    async execute(args, exec) {
      const sessionId = String(args.sessionId ?? "").trim();
      if (sessionId === "") return { ok: false, message: "sessionId 不能为空。" };
      if (typeof args.seq !== "number" || !Number.isFinite(args.seq) || args.seq < 0) {
        return { ok: false, message: "seq 必须是非负整数。" };
      }
      if (!state.ctx.sessionQuery) return { ok: false, message: "host 未提供 sessionQuery，无法展开原文。" };
      try {
        const window = await state.ctx.sessionQuery.readEvent({
          sessionId,
          seq: Math.floor(args.seq),
          before: clampInt(args.before, 2, 0, 20),
          after: clampInt(args.after, 2, 0, 20),
        });
        const lines = window.events.map((event) => {
          const text = eventText(event).trim();
          return `[#${event.seq} ${event.type} ${isoTime(event.time)}]\n${text === "" ? "（无可读文本）" : truncate(text, 2_000)}`;
        });
        return {
          ok: true,
          message: [
            `\`${sessionId}\` seq ${window.startSeq}–${window.endSeq}（目标 #${args.seq}）`,
            `工作目录：${window.session?.cwd ?? "(unknown)"} · 会话开始：${isoTime(window.session?.createdAt ?? 0)}`,
            "",
            ...lines,
          ].join("\n"),
          events: lines,
        };
      } catch (error) {
        return { ok: false, message: `读取失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}

/**
 * Tool: run one trip.
 * @param {any} state - plugin state.
 * @returns {any} tool definition.
 */
function runTool(state) {
  return defineTool({
    name: "reverie_run",
    description:
      "跑一次独立的 Reverie 联想探索：读取只读语料、按需检索展开、最后留一张私人纸条，产物写到 ~/.dsh/reverie/runs/。默认 mock（不调用模型、不产生费用）；live=true 才真的调用模型并产生 API 费用。不写入任何会话或记忆。",
    parameters: {
      live: { type: "boolean", description: "true=真实模型，false=mock；缺省按配置里的 mode" },
      topic: { type: "string", description: "可选的起点提示（不会替模型决定主题）" },
      steps: { type: "number", description: "本次最多模型步骤（默认取配置，最大受配置约束）" },
    },
    output: objectOutput({
      ok: { type: "boolean" },
      message: { type: "string" },
      runId: { type: "string" },
      mode: { type: "string" },
      stopReason: { type: "string" },
      reportPath: { type: "string" },
      handoffPath: { type: "string" },
      steps: { type: "number" },
      inputTokens: { type: "number" },
      outputTokens: { type: "number" },
    }),
    async execute(args, exec) {
      if (state.running) {
        return { ok: false, message: `已经有一趟 Reverie 在运行（${state.running}）；等它结束或取消当前回合。` };
      }
      state.running = `run started ${new Date().toISOString()}`;
      try {
        return await executeRun(state, args, exec);
      } finally {
        state.running = null;
      }
    },
  });
}

/**
 * Body of one run, guarded by the caller's in-flight flag.
 * @param {any} state - plugin state.
 * @param {any} args - model arguments.
 * @param {any} exec - tool run context.
 * @returns {Promise<any>} the canonical tool value.
 */
async function executeRun(state, args, exec) {
  const loaded = await loadForCall(state, exec, { refresh: true });
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const { corpus, settings } = loaded;
  const mode = args.live === true ? "live" : args.live === false ? "mock" : String(settings.mode);
  const steps = Math.min(settings.maxSteps, clampInt(args.steps, settings.maxSteps, 1, settings.maxSteps));
  const language = settings.language === "en" ? "en" : "zh";
  const startedAt = Date.now();
  const id = runId(startedAt, randomSuffix());
  const day = dayKey(startedAt);
  const summary = corpusSummary(corpus);
  const persona = await loadPersona(settings.persona);
  const topic = typeof args.topic === "string" ? args.topic.trim() : "";

  let note = "";
  let events = [];
  let stopReason = "unknown";
  let usage = { input: 0, output: 0, total: 0, steps: 0 };
  let route = { provider: "", model: "" };
  let innerTools = [];

  if (mode === "mock") {
    const index = indexFor(corpus);
    const mock = runMock({
      index,
      documents: corpus.documents,
      language,
      maxNoteChars: settings.maxNoteChars,
    });
    note = mock.note;
    events = mock.events;
    stopReason = mock.stopReason;
    usage = mock.usage;
  } else {
    const resolved = await resolveRoute(state.ctx, settings);
    if (!resolved.ok) {
      return { ok: false, message: `live 运行缺少可用的模型线路：${resolved.reason}` };
    }
    route = { provider: resolved.provider, model: resolved.model };
    const toolContext = { corpus, index: indexFor(corpus), language };
    innerTools = buildInnerTools(toolContext);
    const opening =
      topic === ""
        ? openingMessage({ ...summary, scope: String(settings.scope), maxSteps: steps, language })
        : `${openingMessage({ ...summary, scope: String(settings.scope), maxSteps: steps, language })}\n\n${language === "en" ? "Starting point hint: " : "起点提示："}${topic}`;
    const result = await runLoop({
      llm: state.ctx.llm,
      messages: state.messages,
      provider: route.provider,
      model: route.model,
      system: systemPrompt({
        language,
        maxNoteChars: settings.maxNoteChars,
        maxSteps: steps,
        persona,
      }),
      opening,
      tools: innerTools,
      budget: {
        maxSteps: steps,
        maxInputTokens: settings.maxInputTokens,
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: settings.timeoutMs,
        maxNoteChars: settings.maxNoteChars,
        reasoningEffort: settings.reasoningEffort,
      },
      signal: exec.signal,
    });
    note = result.note === "" ? missingNote(language) : result.note;
    events = result.events;
    stopReason = result.stopReason;
    usage = result.usage;
  }

  const endedAt = Date.now();
  const meta = {
    run_id: id,
    day,
    schema: "dsh-reverie/run@1",
    mode,
    provider: route.provider,
    model: route.model,
    started_at: isoTime(startedAt),
    ended_at: isoTime(endedAt),
    stop_reason: stopReason,
    language,
    corpus: {
      scope: settings.scope,
      sessions: summary.sessions,
      documents: summary.documents,
      chars: summary.chars,
      oldest: summary.oldest === null ? "" : isoTime(summary.oldest),
      newest: summary.newest === null ? "" : isoTime(summary.newest),
      problems: corpus.problems,
    },
    budget: {
      max_steps: steps,
      max_input_tokens: settings.maxInputTokens,
      max_output_tokens: settings.maxOutputTokens,
      timeout_ms: settings.timeoutMs,
    },
    usage: {
      input: usage.input,
      output: usage.output,
      total: usage.total,
      steps: usage.steps,
    },
  };
  const written = await writeRun({
    root: runsRoot(),
    meta,
    note,
    evidence: evidenceFromEvents(events, corpus),
    events,
    language,
  });
  state.lastRun = { id, day, mode, stopReason, reportPath: written.reportPath };
  const handoffPath = path.join(written.directory, "handoff.md");
  const modeLine = mode === "live" ? `真实模型：${route.provider} / ${route.model}` : "mock：未调用任何模型";
  const message = [
    `Reverie 跑完一趟（${mode}）。`,
    `运行：\`${id}\` · 结束原因：\`${stopReason}\` · 步数 ${usage.steps} · 输入 ${usage.input} / 输出 ${usage.output} tokens`,
    `语料：${summary.sessions} 个会话 / ${summary.documents} 条消息（scope \`${settings.scope}\`）`,
    modeLine,
    "",
    "私人纸条：",
    truncate(note, 1_600),
    "",
    `产物：${written.directory}`,
    `报告：${written.reportPath}`,
  ].join("\n");
  return {
    ok: true,
    message,
    runId: id,
    mode,
    stopReason,
    reportPath: written.reportPath,
    handoffPath,
    steps: usage.steps,
    inputTokens: usage.input,
    outputTokens: usage.output,
  };
}

/**
 * Fallback note when a live run ended without writing one.
 * @param {"zh" | "en"} language - report language.
 * @returns {string} the note.
 */
function missingNote(language) {
  return language === "en"
    ? "_The run ended without calling `reverie_note`, so there is no private note. The trail below is the record._"
    : "_这一趟没有调用 `reverie_note`，所以没有私人纸条。下面的轨迹是唯一的记录。_";
}

/**
 * Collect evidence locators mentioned in the run's tool results.
 * @param {any[]} events - run events.
 * @param {any} corpus - corpus used by the run.
 * @returns {{sessionId: string, seq: number, time: string, snippet: string}[]} evidence index entries.
 */
function evidenceFromEvents(events, corpus) {
  /** @type {Map<string, {sessionId: string, seq: number, time: string, snippet: string}>} */
  const seen = new Map();
  for (const event of events) {
    if (event.kind !== "tool" || event.isError) continue;
    const text = String(event.result ?? "");
    const matches = text.matchAll(/([\w-]+)#(\d+)/g);
    for (const match of matches) {
      const sessionId = match[1];
      const seq = Number(match[2]);
      const key = `${sessionId}#${seq}`;
      if (seen.has(key)) continue;
      const document = corpus.documents.find((candidate) => candidate.sessionId === sessionId && candidate.seq === seq);
      seen.set(key, {
        sessionId,
        seq,
        time: document ? isoTime(document.time) : "",
        snippet: document ? oneLine(document.text, 120) : "",
      });
      if (seen.size >= 24) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

/**
 * Load an optional persona file.
 * @param {string} value - configured path.
 * @returns {Promise<string>} the persona text, or "" when absent.
 */
async function loadPersona(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(value.trim(), "utf8");
    return truncate(content, 8_000);
  } catch {
    return "";
  }
}

/**
 * Build the tools the *inner* model may call during a run.
 * @param {{corpus: any, index: any, language: "zh" | "en"}} context - run-scoped state.
 * @returns {any[]} inner tool definitions.
 */
export function buildInnerTools(context) {
  const english = context.language === "en";
  return [
    {
      name: "reverie_search",
      description: english
        ? "Lexical search over the read-only corpus. Returns ranked excerpts with `<sessionId>#<seq>` locators."
        : "在只读语料里做词法检索，返回带 `<sessionId>#<seq>` locator 的排序片段。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: english ? "Literal words or phrase" : "字面检索词或短语" },
          limit: { type: "number", description: english ? "Max hits (default 6)" : "条数（默认 6）" },
        },
        required: ["query"],
      },
      async execute(args) {
        const { hits, total } = searchIndex(context.index, String(args.query ?? ""), {
          limit: clampInt(args.limit, 6, 1, 10),
        });
        if (hits.length === 0) {
          return `No hit for ${JSON.stringify(args.query)} across ${context.corpus.documents.length} messages (${total} scored).`;
        }
        const lines = hits.map((hit, position) => {
          const document = context.corpus.documents[hit.position];
          return `${position + 1}. \`${document.sessionId}#${document.seq}\` ${document.role} ${document.time ? isoTime(document.time) : ""}\n${oneLine(hit.snippet, 500)}`;
        });
        return lines.join("\n\n");
      },
    },
    {
      name: "reverie_read",
      description: english
        ? "Expand one locator into the original window: the exact message text plus a few neighbours."
        : "按 locator 展开原文窗口：该事件及前后若干条事件的完整文本。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", description: english ? "Session id from a locator" : "locator 里的会话 id" },
          seq: { type: "number", description: english ? "Event seq from a locator" : "locator 里的 seq" },
          before: { type: "number", description: english ? "Neighbours before (default 2)" : "向前条数（默认 2）" },
          after: { type: "number", description: english ? "Neighbours after (default 2)" : "向后条数（默认 2）" },
        },
        required: ["sessionId", "seq"],
      },
      async execute(args) {
        const document = context.corpus.documents.find(
          (candidate) => candidate.sessionId === String(args.sessionId) && candidate.seq === Number(args.seq),
        );
        if (!document) return `Locator not readable from the corpus snapshot: ${args.sessionId}#${args.seq}`;
        const before = clampInt(args.before, 2, 0, 6);
        const after = clampInt(args.after, 2, 0, 6);
        const position = context.corpus.documents.indexOf(document);
        const slice = context.corpus.documents.slice(Math.max(0, position - before), position + after + 1);
        return slice
          .map((item) => `[${item.sessionId}#${item.seq} ${item.role}]\n${truncate(item.text, 1_500)}`)
          .join("\n\n");
      },
    },
    {
      name: "reverie_note",
      description: english
        ? "Write the run's private note (bounded). Call once before finishing."
        : "写下这一趟的私人纸条（有长度上限）。结束前调用一次。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: {
            type: "string",
            description: english ? "Markdown note, bounded by the run's limit" : "markdown 纸条，受运行的长度上限约束",
          },
        },
        required: ["note"],
      },
      async execute(args, exec) {
        const limit = exec?.maxNoteChars ?? 2_000;
        const note = truncate(String(args.note ?? "").trim(), limit);
        if (note === "") return "Empty note ignored; write something, even if it says the trip produced nothing.";
        return { type: "reverie-note", note };
      },
    },
  ];
}

/**
 * Tool: read back a run.
 * @param {any} state - plugin state.
 * @returns {any} tool definition.
 */
function reportTool(state) {
  return defineTool({
    name: "reverie_report",
    description:
      "回看 Reverie 产物：不带参数列出最近的运行并可取最近的私人纸条；带 run（如 rev-20261020-031500-abcd）时读取该运行的 report/handoff/trail。只读。",
    parameters: {
      run: { type: "string", description: "运行 id；缺省时列出最近运行" },
      file: {
        type: "string",
        enum: ["report", "handoff", "trail", "meta", "usage"],
        description: "要读的文件（默认 report）",
      },
      limit: { type: "number", description: "列出的运行条数（默认 10，最大 50）" },
    },
    output: objectOutput({
      ok: { type: "boolean" },
      message: { type: "string" },
      runId: { type: "string" },
      runs: { type: "array", items: { type: "string" } },
    }),
    async execute(args) {
      const root = runsRoot();
      const fileMap = {
        report: "report.md",
        handoff: "handoff.md",
        trail: "events.jsonl",
        meta: "run.json",
        usage: "usage.json",
      };
      const requested = String(args.run ?? "").trim();
      if (requested !== "") {
        const name = fileMap[args.file ?? "report"] ?? fileMap.report;
        try {
          const { content } = await readRunFile(root, requested, name);
          return {
            ok: true,
            message: [`\`${requested}\` · ${name}`, "", truncate(content, REPORT_LIMIT)].join("\n"),
            runId: requested,
            runs: [],
          };
        } catch (error) {
          return { ok: false, message: `读取失败：${error instanceof Error ? error.message : String(error)}` };
        }
      }
      const runs = await listRuns(root, clampInt(args.limit, 10, 1, 50));
      if (runs.length === 0) {
        return { ok: true, message: `还没有任何运行记录。产物根目录：${root}`, runId: "", runs: [] };
      }
      const note = await latestNote(root, { allowMock: true }).catch(() => null);
      const lines = runs.map((run) => `- \`${run.runId}\` · ${run.mode} · ${run.stopReason} · ${run.endedAt}`);
      const message = [
        `最近 ${runs.length} 次运行：`,
        "",
        ...lines,
        note ? `\n最近一张私人纸条（\`${note.runId}\` · ${note.mode}）：\n${truncate(note.note, 2_000)}` : "",
        `\n产物根目录：${root}`,
      ]
        .join("\n")
        .trim();
      return { ok: true, message, runId: "", runs: runs.map((run) => run.runId) };
    },
  });
}

/**
 * Tool: inspect or change settings.
 * @param {any} state - plugin state.
 * @returns {any} tool definition.
 */
function configTool(state) {
  return defineTool({
    name: "reverie_config",
    description:
      "查看或修改 dsh-reverie 运行配置（存 ~/.dsh/reverie/config.json）。不带参数即查看；set 传部分字段做校验后合并；reset=true 恢复默认。改 mode 为 live 会让后续运行真的调用模型并产生费用。",
    parameters: {
      set: {
        type: "object",
        additionalProperties: true,
        description: "要修改的字段（见过的键见下）",
      },
      reset: { type: "boolean", description: "恢复默认配置（默认 false）" },
    },
    output: objectOutput({
      ok: { type: "boolean" },
      message: { type: "string" },
      configPath: { type: "string" },
      settings: { type: "json" },
      rejected: { type: "array", items: { type: "string" } },
    }),
    async execute(args) {
      const current = await readConfig();
      let settings = current.settings;
      const rejected = [];
      if (args.reset === true) {
        settings = { ...DEFAULTS };
        await writeConfig(settings);
      } else if (args.set && typeof args.set === "object") {
        const applied = merge(current.settings, args.set);
        rejected.push(...applied.rejected.map((entry) => `${entry.key}: ${entry.reason}`));
        settings = applied.settings;
        await writeConfig(settings);
      }
      const path = current.path;
      const listed = Object.keys(settings)
        .map((key) => `- \`${key}\`: ${JSON.stringify(settings[key])}`)
        .join("\n");
      const message = [
        args.reset === true || (args.set && typeof args.set === "object") ? "已更新配置。" : "当前配置：",
        `文件：${path}`,
        "",
        listed,
        rejected.length > 0 ? `\n未接受的字段：\n- ${rejected.join("\n- ")}` : "",
        "\n键说明：scope=workspace|all、includeSubagents、maxSessions、lookbackDays、maxDocuments、minDocumentChars、cacheTtlMs、provider、model、reasoningEffort、mode=mock|live、maxSteps、maxInputTokens、maxOutputTokens、timeoutMs、maxNoteChars、persona、language=zh|en",
      ]
        .join("\n")
        .trim();
      return { ok: true, message, configPath: path, settings, rejected };
    },
  });
}

/**
 * Build the complete tool list for one plugin instance.
 * @param {any} state - plugin state (`ctx`, `messages`, `running`, `lastRun`).
 * @returns {any[]} tool definitions.
 */
export function buildTools(state) {
  return [
    statusTool(state),
    sessionsTool(state),
    searchTool(state),
    readTool(state),
    runTool(state),
    reportTool(state),
    configTool(state),
  ];
}

/**
 * Drop the corpus cache; exposed for `reverie_config`-driven scope changes and tests.
 * @returns {void}
 */
export function resetCache() {
  clearCorpusCache();
}
