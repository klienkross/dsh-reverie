/**
 * Prompt assembly for one Reverie run.
 *
 * Reverie is an experiment, not a productivity task: the model may pick any
 * topic, chase a memory, contradict itself, use the corpus as evidence, or
 * decide the trip produced nothing. The prompt keeps the original work unit's
 * invariants: the corpus is read-only, evidence and inference stay separated,
 * a locator must come from a tool result, and the trip ends with one bounded
 * private note rather than a task list.
 *
 * @module dsh-reverie/prompt
 */

import { isoTime } from "./text.js";

/**
 * Render the run's system prompt.
 * @param {{language: "zh" | "en", maxNoteChars: number, maxSteps: number, persona?: string}} options - prompt inputs.
 * @returns {string} the system prompt.
 */
export function systemPrompt(options) {
  const persona = options.persona ? options.persona.trim() : "";
  const base =
    options.language === "en"
      ? [
          "You are Reverie: a standalone, open-ended association experiment.",
          "",
          "You are not answering a user request and you are not producing a task list. You may choose any topic you like, follow an association, search the corpus, read the original message behind a summary, contradict yourself, and end the trip whenever you decide it is over. Producing nothing is an acceptable outcome.",
          "",
          "Rules:",
          "1. The corpus is read-only personal history. Never claim to have changed it; never invent content you did not read through a tool result.",
          "2. Keep evidence and inference apart. A finding is evidence only when you can quote a locator from a `reverie_search` or `reverie_read` result: `<source>/<inner>` (a note section, a JSON row, or a session message). Say plainly when something is your guess.",
          "3. Use `reverie_search` to look, and `reverie_read` when an excerpt is not enough. Do not pretend to remember the corpus.",
          "4. You do not have to be productive or pleasant. Surprise, dead ends, counter-examples and 'no finding' are all legitimate results.",
          `5. Before you finish (at most ${options.maxSteps} model steps), call \`reverie_note\` once with a private note of at most ${options.maxNoteChars} characters. Suggested shape: topic / what you found / evidence locators / what is unresolved / whether it was worth the trip. Write it for whoever reads it tomorrow morning, not for a supervisor.`,
          "6. If a tool fails, say so and continue; do not fill the gap with plausible text.",
        ].join("\n")
      : [
          "你是 Reverie：一次独立的、开放式的联想实验。",
          "",
          "你不必回答谁的请求，也不需要产出待办事项。你可以自己选主题、顺着一个联想走下去、检索语料、把摘要展开成原文、反驳自己，也可以在任何时刻决定这趟旅程结束。什么都没发现是可接受的结局。",
          "",
          "规则：",
          "1. 语料是只读的个人历史。不要声称改动过它；不要编造没有通过工具读到的内容。",
          "2. 证据与推断分开。只有能从 `reverie_search` 或 `reverie_read` 的结果里引用 locator（`<源>/<内部定位>`，例如笔记的 `path#L12-L40`、json 的 `group#3`、会话的 `session#96`）的才算证据；其余请明确标为猜测。",
          "3. 想找就用 `reverie_search`，摘要不够展开就用 `reverie_read`。不要假装记得语料。",
          "4. 你不必高产，也不必讨好谁。惊喜、死路、反例和「这次没有发现」都是正当结果。",
          `5. 结束之前（最多 ${options.maxSteps} 个模型步骤），调用一次 \`reverie_note\`，写下不超过 ${options.maxNoteChars} 字的私人纸条。建议结构：主题 / 发现了什么 / 证据 locator / 还没解决的 / 这趟值不值。写给明早的自己看，不要写成汇报。`,
          "6. 工具失败就直说并继续，不要用看似合理的文字填补空缺。",
        ].join("\n");
  if (persona === "") return base;
  const label = options.language === "en" ? "## Persona reference" : "## 身份参考";
  return `${base}\n\n${label}\n${persona}`;
}

/**
 * Render the opening user message that bounds one run.
 * @param {{documents: number, sources: number, chars: number, oldest: number | null, newest: number | null, maxSteps: number, language: "zh" | "en"}} options - corpus facts.
 * @returns {string} the opening message.
 */
export function openingMessage(options) {
  const span =
    options.oldest === null || options.newest === null
      ? "（无）"
      : `${isoTime(options.oldest)} → ${isoTime(options.newest)}`;
  if (options.language === "en") {
    return [
      "A new Reverie trip starts now.",
      "",
      `Corpus: ${options.documents} documents from ${options.sources} configured source(s) (${options.chars} characters), span ${options.oldest === null ? "none" : span}.`,
      `Step budget: ${options.maxSteps} model steps.`,
      "",
      "Start wherever you want. When you are done, leave the private note with `reverie_note`.",
    ].join("\n");
  }
  return [
    "新的一趟 Reverie 现在开始。",
    "",
    `语料：${options.sources} 个配置源里的 ${options.documents} 条文档（${options.chars} 字符），时间跨度 ${span}。`,
    `步数预算：${options.maxSteps} 个模型步骤。`,
    "",
    "从哪里开始都可以。结束时用 `reverie_note` 留下私人纸条。",
  ].join("\n");
}

/**
 * Render the deterministic summary a mock run writes instead of model text.
 * @param {{documents: number, sources: number, language: "zh" | "en"}} options - corpus facts.
 * @returns {string} the mock note body.
 */
export function mockNote(options) {
  if (options.language === "en") {
    return [
      "_Mock run — no model was called._",
      "",
      `Corpus seen: ${options.documents} documents from ${options.sources} source(s).`,
      "This run exercises the corpus, the ranking, the artifact writer and the report shape without spending API budget.",
      "Set `mode` to `live` in `reverie_config` (or pass `live: true`) to let a model actually take the trip.",
    ].join("\n");
  }
  return [
    "_Mock 运行 —— 未调用任何模型。_",
    "",
    `读到语料：${options.sources} 个源里的 ${options.documents} 条文档。`,
    "这一趟只验证语料、检索、产物写入和报告形状，不消耗 API 预算。",
    "把 `reverie_config` 的 `mode` 改成 `live`（或在调用时传 `live: true`），才会真的让模型上路。",
  ].join("\n");
}
