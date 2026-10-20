/**
 * dsh-reverie plugin entry.
 *
 * Mounts seven agent tools plus one system-prompt announcement. Everything the
 * plugin reads goes through `ctx.sessionQuery`, everything it writes stays
 * under `$DSH_HOME/reverie/`, and it never appends to a session, a memory
 * store, or the corpus. A live run is the only path that spends model budget,
 * and it is opt-in per call or through `reverie_config`.
 *
 * @module dsh-reverie
 */

import { messageFactories } from "./messages.js";
import { buildTools } from "./tools.js";

/** Stable cordis plugin name. */
export const name = "reverie";

/** Services that must exist before the tools can mount. */
export const inject = ["tools", "systemPrompt"];

/**
 * Read one optional host service without failing when it is absent.
 *
 * Only `tools` and `systemPrompt` are hard dependencies: a composition without
 * a model adapter or a session-query backend should still mount the plugin and
 * let the tools explain what is missing, instead of silently dropping the whole
 * surface.
 * @param {any} ctx - host context.
 * @param {string} name - service name.
 * @returns {any} the service or undefined.
 */
function optionalService(ctx, name) {
  try {
    const resolved = typeof ctx.get === "function" ? ctx.get(name) : undefined;
    return resolved ?? ctx[name];
  } catch {
    return ctx[name];
  }
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 216;

/** Model-facing announcement: what this plugin is for and what it will not do. */
const REVERIE_GUIDANCE = [
  "本机已安装 dsh-reverie 插件（Reverie 开放式联想实验）：把**只读语料**（笔记目录 / JSON 导出 / 本机会话历史）当作探索材料，跑一次独立的联想，产出一份报告和一张有界的私人纸条。",
  "",
  "工具：`reverie_status`（配置/语料/线路状态）、`reverie_sources`（列出语料源与分组）、`reverie_search`（词法检索，返回 `<源>/<内部定位>` locator）、`reverie_read`（按 locator 展开原文）、`reverie_run`（跑一趟，默认 mock 不调用模型）、`reverie_report`（回看产物）、`reverie_config`（查看/修改配置与 `sources`）。",
  "",
  "重要限制：",
  "1. 只读语料：不写入、不改写任何会话、笔记、memory 或语料；产物只写 `~/.dsh/reverie/runs/`。",
  "2. 默认 `mode=mock`，不调用模型、不产生费用；`reverie_run(live:true)` 或把配置改成 `live` 才会真跑，并产生 API 费用。",
  "3. 语料由 `reverie_config` 的 `sources` 决定：folder（笔记目录）、json（JSONL/JSON 导出）、dsh-sessions（本机已关闭的会话历史，排除当前活跃会话）。",
  "4. 报告与纸条是模型生成材料，不是权威记忆；引用任何结论前应按 locator 展开原文。",
  "",
  "用户提到「Reverie / 联想 / 记忆探索 / 夜间手记」时即指本插件，请据此协作。",
].join("\n");

/**
 * Mount the Reverie tools and announcement.
 * @param {any} ctx - host plugin context carrying tools/systemPrompt/llm/sessionQuery.
 * @param {{announceToAgent?: boolean, enabled?: boolean}} [config] - plugin row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const enabled = config?.enabled !== false;
  const announceToAgent = config?.announceToAgent !== false;
  if (!enabled) return;

  const state = {
    ctx: {
      get sessionQuery() {
        return optionalService(ctx, "sessionQuery");
      },
      get llm() {
        return optionalService(ctx, "llm");
      },
    },
    messages: messageFactories,
    running: null,
    lastRun: null,
  };

  ctx.effect(() => {
    const disposers = buildTools(state).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-reverie: tools");

  if (announceToAgent) {
    ctx.systemPrompt.section({
      name: "plugin:dsh-reverie",
      order: SECTION_ORDER,
      text: REVERIE_GUIDANCE,
    });
  }
}

export { REVERIE_GUIDANCE };
