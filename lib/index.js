/**
 * dsh-reverie plugin entry.
 *
 * Mounts seven agent tools, one system-prompt announcement, and (when the host
 * has a web server) the read-only panel routes. Everything the plugin reads
 * goes through the configured corpus sources, everything it writes stays under
 * `$DSH_HOME/reverie/`, and it never appends to a session, a memory store, or
 * the corpus. A live run is the only path that spends model budget, and it is
 * opt-in per call or through `reverie_config`.
 *
 * Mounting is deliberately fault-isolated: the host GUI shows no plugin load
 * error, so every step is attempted independently, and any failure is appended
 * to `$DSH_HOME/reverie/apply-error.log` instead of silently taking the whole
 * plugin down. A half-mounted plugin that still exposes tools is worth more
 * than a vanished one.
 *
 * @module dsh-reverie
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { reverieRoot } from "./config.js";
import { messageFactories } from "./messages.js";
import { makeRoutes } from "./routes.js";
import { buildTools } from "./tools.js";

/** Stable cordis plugin name. */
export const name = "reverie";

/** Services that must exist before the tools can mount. */
export const inject = ["tools", "systemPrompt"];

/**
 * Append one mount failure (or success marker) to the plugin's diagnostic file.
 * Never throws: a broken diagnostic must not break the plugin again.
 * @param {string} label - which step failed.
 * @param {unknown} [error] - the thrown value, when there is one.
 * @returns {void}
 */
function recordFailure(label, error) {
  try {
    const root = reverieRoot();
    mkdirSync(root, { recursive: true });
    const detail =
      error === undefined ? "ok" : error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    appendFileSync(path.join(root, "apply-error.log"), `${new Date().toISOString()} [${label}] ${detail}\n`, "utf8");
  } catch {
    // Diagnostics are best-effort.
  }
  if (error !== undefined) {
    try {
      console.error(`[dsh-reverie] ${label} failed:`, error);
    } catch {
      // No console in this runtime.
    }
  }
}

/**
 * Run one mount step without letting it take the whole plugin down.
 * @param {string} label - step name for the diagnostic log.
 * @param {() => any} fn - the step.
 * @returns {any} the step's value, or undefined when it threw.
 */
function attempt(label, fn) {
  try {
    return fn();
  } catch (error) {
    recordFailure(label, error);
    return undefined;
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
 * Mount the Reverie tools, panel routes and announcement.
 * @param {any} ctx - host plugin context carrying tools/systemPrompt/llm/sessionQuery.
 * @param {{announceToAgent?: boolean, enabled?: boolean}} [config] - plugin row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  // A disabled row is not a failure: mount nothing and leave no trace.
  if (config?.enabled === false) return;
  try {
    mount(ctx, config);
    recordFailure("apply-ok");
  } catch (error) {
    // A throw here means the host dropped the plugin; keep the trace anyway.
    recordFailure("apply", error);
    throw error;
  }
}

/**
 * The mount body, with each part isolated.
 * @param {any} ctx - host context.
 * @param {{announceToAgent?: boolean, enabled?: boolean}} [config] - row config.
 * @returns {void}
 */
function mount(ctx, config) {
  const enabled = config?.enabled !== false;
  const announceToAgent = config?.announceToAgent !== false;
  if (!enabled) return;

  // Cordis contexts are proxies: touching an undeclared service property throws
  // (`cannot get property "<name>" without inject`). Optional services are
  // therefore resolved through `ctx.inject` callbacks, which run only when the
  // service exists, and the resolved handles are what the tools use.
  const services = { llm: undefined, sessionQuery: undefined };
  const state = {
    ctx: {
      get sessionQuery() {
        return services.sessionQuery;
      },
      get llm() {
        return services.llm;
      },
    },
    messages: messageFactories,
    running: null,
    lastRun: null,
  };

  attempt("services", () => {
    if (typeof ctx.inject === "function") {
      ctx.inject(["llm"], (child) => {
        services.llm = child.llm;
      });
      ctx.inject(["sessionQuery"], (child) => {
        services.sessionQuery = child.sessionQuery;
      });
      return;
    }
    // Plain-object contexts (tests, minimal hosts) expose services directly.
    services.llm = ctx.llm;
    services.sessionQuery = ctx.sessionQuery;
  });

  attempt("tools", () =>
    ctx.effect(() => {
      /** @type {(() => void)[]} */
      const disposers = [];
      let tools;
      try {
        tools = buildTools(state);
      } catch (error) {
        recordFailure("tools-build", error);
        tools = [];
      }
      for (const tool of tools) {
        try {
          disposers.push(ctx.tools.register(tool));
        } catch (error) {
          recordFailure(`tools-register:${tool.name}`, error);
        }
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-reverie: tools"),
  );

  /**
   * Register the panel routes against one web-server service.
   * @param {any} webServer - the host's web server service.
   * @param {any} scoped - the context that owns the routes' lifetime.
   * @returns {void}
   */
  const registerRoutes = (webServer, scoped) => {
    if (!webServer || typeof webServer.register !== "function") return;
    scoped.effect(() => {
      /** @type {(() => void)[]} */
      const disposers = [];
      for (const route of makeRoutes()) {
        try {
          const dispose = webServer.register(route);
          if (typeof dispose === "function") disposers.push(dispose);
        } catch (error) {
          recordFailure(`route-register:${route.path}`, error);
        }
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "dsh-reverie: panel routes");
  };

  // The panel is a viewer: its routes only list and read recorded artifacts.
  // A composition without a web server (or a headless one) still mounts the
  // tools; the panel simply never appears.
  attempt("routes", () => {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], (child) => registerRoutes(child.webServer, child));
      return;
    }
    registerRoutes(ctx.webServer, ctx);
  });


  attempt("announcement", () => {
    if (!announceToAgent) return;
    ctx.systemPrompt.section({
      name: "plugin:dsh-reverie",
      order: SECTION_ORDER,
      text: REVERIE_GUIDANCE,
    });
  });
}

export { REVERIE_GUIDANCE };
