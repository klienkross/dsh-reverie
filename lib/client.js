/**
 * Reverie panel — the web client half of the plugin.
 *
 * This file is loaded by the DSH client module loader
 * (`window.__ModuleLoader__.load`), not by Node: it registers one settings
 * section that lists recorded runs and shows them in one of two themes.
 *
 * `archive` (default) is the sampling view: the whole corpus as a dim daily
 * density strip, with the documents this trip actually touched lit in amber.
 * `road` is the journey view carried over from the original Reverie frontend:
 * stats, a step trail, and the private note.
 *
 * Both themes are viewers. They talk only to the read-only routes in
 * `lib/routes.js`; nothing here can start a run.
 */

// Importing this module in Node (tools, tests, a mistaken host-side import) must
// not throw: the loader only exists in the browser, where the shell provides it.
const moduleLoader = typeof window !== "undefined" ? window.__ModuleLoader__ : undefined;

if (moduleLoader) moduleLoader.load({
  id: "@kleinkross/dsh-reverie",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** Palette carried over from the original Reverie frontend. */
    const C = {
      bg: "#0d1023",
      panel: "#14192f",
      line: "#2a314b",
      text: "#e0e4f0",
      muted: "#94a2bc",
      cyan: "#8bd9e8",
      amber: "#e4c18b",
      pink: "#f36b9b",
      lavender: "#b2a0ef",
      dim: "#1b233d",
      bar: "#232b45",
    };

    const API = {
      runs: "/api/dsh-reverie/runs",
      run: "/api/dsh-reverie/run",
      file: "/api/dsh-reverie/file",
      corpus: "/api/dsh-reverie/corpus",
    };

    const TABS = [
      ["report", "报告"],
      ["handoff", "纸条"],
      ["trail", "轨迹"],
      ["evidence", "证据"],
    ];

    /**
     * Fetch JSON with a readable error.
     * @param {string} url - request URL.
     * @returns {Promise<any>} parsed body.
     */
    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}: 响应不是 JSON`);
      }
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }

    /**
     * Parse the run trail into display steps.
     * @param {string} text - events.jsonl content.
     * @returns {{kind: string, step: number, title: string, body: string, detail: string}[]} steps.
     */
    function parseTrail(text) {
      const steps = [];
      for (const line of String(text ?? "").split(/\r?\n/)) {
        if (line.trim() === "") continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const step = Number.isFinite(event.step) ? event.step : 0;
        if (event.kind === "assistant") {
          const calls = (event.toolCalls ?? []).map((call) => call.name).join(" · ");
          steps.push({
            kind: "assistant",
            step,
            title: calls === "" ? "模型收尾" : `调用 ${calls}`,
            body: event.text ?? "",
            detail: event.reasoning ?? "",
          });
        } else if (event.kind === "tool") {
          steps.push({
            kind: "tool",
            step,
            title: `${event.name}${event.isError ? "（失败）" : ""}`,
            body: String(event.result ?? ""),
            detail: String(event.arguments ?? ""),
          });
        } else if (event.kind === "finalize") {
          steps.push({ kind: "finalize", step, title: "强制收尾纸条", body: `end after ${event.after}`, detail: "" });
        } else if (event.kind === "settlement") {
          steps.push({
            kind: "settlement",
            step,
            title: `结束：${event.stopReason}`,
            body: `noteCalls ${event.noteCalls} · tokens ${event.usage?.total ?? 0}`,
            detail: "",
          });
        }
      }
      return steps;
    }

    /**
     * Pull evidence locators out of the trail.
     * @param {{kind: string, body: string}[]} steps - parsed trail.
     * @returns {{locator: string, snippet: string}[]} unique locators with a short excerpt.
     */
    function collectEvidence(steps) {
      const seen = new Map();
      const pattern = /[a-z0-9][a-z0-9_-]*\/[^\s`"]+?#L\d+-L\d+/g;
      for (const step of steps) {
        if (step.kind !== "tool") continue;
        const found = String(step.body ?? "").match(pattern) ?? [];
        for (const locator of found) {
          if (seen.has(locator)) continue;
          seen.set(locator, { locator, snippet: String(step.body).slice(0, 160) });
        }
      }
      return [...seen.values()];
    }

    /**
     * Group touched documents by day for the density strip.
     * @param {{locator: string, time: number | null}[] | undefined} touched - touched entries.
     * @returns {Map<string, number>} day → touched count.
     */
    function touchedByDay(touched) {
      const counts = new Map();
      for (const entry of touched ?? []) {
        if (typeof entry.time !== "number" || !Number.isFinite(entry.time)) continue;
        const day = new Date(entry.time).toISOString().slice(0, 10);
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }
      return counts;
    }

    const styles = {
      root: {
        background: C.bg,
        color: C.text,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: 18,
        fontFamily: '"Segoe UI","Microsoft YaHei",sans-serif',
        fontSize: 13,
      },
      head: { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" },
      eyebrow: { color: C.muted, fontSize: 9, letterSpacing: 2 },
      title: { margin: "4px 0", fontSize: 18, fontWeight: 500 },
      badge: { fontSize: 9, color: C.cyan, border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 6px" },
      row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "12px 0" },
      select: {
        background: C.panel,
        color: C.text,
        border: `1px solid ${C.line}`,
        borderRadius: 6,
        padding: "6px 8px",
        fontSize: 12,
      },
      button: {
        background: "transparent",
        color: C.text,
        border: `1px solid ${C.line}`,
        borderRadius: 6,
        padding: "6px 11px",
        fontSize: 12,
        cursor: "pointer",
      },
      themeButton: (active) => ({
        background: active ? C.dim : "transparent",
        color: active ? C.amber : C.muted,
        border: `1px solid ${active ? C.amber : C.line}`,
        borderRadius: 6,
        padding: "5px 10px",
        fontSize: 11,
        cursor: "pointer",
      }),
      tab: (active) => ({
        background: active ? C.dim : "transparent",
        color: active ? C.cyan : C.muted,
        border: "0",
        borderBottom: `1px solid ${active ? C.cyan : "transparent"}`,
        padding: "7px 12px",
        fontSize: 12,
        cursor: "pointer",
      }),
      stats: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10, margin: "14px 0" },
      stat: { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 7, padding: "10px 12px" },
      statLabel: { color: C.muted, fontSize: 10 },
      statValue: { fontSize: 20, marginTop: 4, fontFamily: 'Consolas,"Microsoft YaHei",monospace' },
      strip: {
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        height: 52,
        padding: "8px 10px 0",
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 7,
        marginTop: 10,
        overflowX: "hidden",
      },
      barWrap: {
        flex: "1 1 0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        minWidth: 0,
      },
      bar: { width: "100%", borderRadius: 1, background: C.bar },
      marker: { borderRadius: 50, background: C.amber, marginBottom: 2, flex: "none" },
      stripFoot: { display: "flex", justifyContent: "space-between", color: C.muted, fontSize: 9, marginTop: 4 },
      panel: { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 7, padding: 14, marginTop: 10 },
      pre: {
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: 'Consolas,"Microsoft YaHei",monospace',
        fontSize: 11,
        lineHeight: 1.8,
        color: "#b0bfd6",
        margin: 0,
        maxHeight: 460,
        overflow: "auto",
      },
      step: { borderBottom: `1px solid ${C.line}`, padding: "9px 0" },
      stepHead: { display: "flex", gap: 10, alignItems: "baseline" },
      stepNo: { fontFamily: "Consolas,monospace", fontSize: 10, color: C.muted, minWidth: 26 },
      stepTitle: { fontSize: 12 },
      stepBody: { margin: "6px 0 0 36px" },
      locator: { color: C.amber, fontFamily: "Consolas,monospace", fontSize: 10, wordBreak: "break-all" },
      empty: { color: C.muted, padding: "18px 4px", fontSize: 12 },
      error: { color: C.pink, fontSize: 12, whiteSpace: "pre-wrap" },
    };

    /**
     * One stats tile.
     * @param {{label: string, value: string}} props - tile content.
     * @returns {any} element.
     */
    function Stat(props) {
      return h(
        "div",
        { style: styles.stat },
        h("div", { style: styles.statLabel }, props.label),
        h("div", { style: styles.statValue }, props.value),
      );
    }

    /**
     * Daily corpus density with the touched documents marked.
     * @param {{corpus: any, touched: any[] | undefined}} props - corpus histogram and touched entries.
     * @returns {any} element.
     */
    function DensityStrip(props) {
      const days = props.corpus?.days ?? [];
      if (days.length === 0) return h("div", { style: styles.empty }, "语料没有时间信息，无法画出采样条。");
      const counts = touchedByDay(props.touched);
      const max = Math.max(1, ...days.map((day) => day.documents));
      const lit = days.filter((day) => (counts.get(day.day) ?? 0) > 0);
      return h(
        "div",
        null,
        h(
          "div",
          { style: styles.strip, "aria-label": "语料密度与触碰点" },
          ...days.map((day) => {
            const hits = counts.get(day.day) ?? 0;
            const height = Math.max(2, Math.round((day.documents / max) * 36));
            const size = Math.min(9, 3 + hits * 2);
            return h(
              "div",
              {
                key: day.day,
                style: styles.barWrap,
                title: `${day.day} · ${day.documents} 篇${hits > 0 ? ` · 点亮 ${hits}` : ""}`,
              },
              hits > 0 ? h("div", { style: { ...styles.marker, width: size, height: size } }) : null,
              h("div", { style: { ...styles.bar, height, background: hits > 0 ? C.amber : C.bar } }),
            );
          }),
        ),
        h(
          "div",
          { style: styles.stripFoot },
          h("span", null, `${days[0].day} → ${days[days.length - 1].day}`),
          h("span", null, `${lit.length} 天被触碰 · ${props.touched?.length ?? 0} 篇点亮`),
        ),
      );
    }

    /**
     * The step trail list, shared by both themes.
     * @param {{steps: any[], loaded: boolean}} props - parsed trail.
     * @returns {any} element.
     */
    function StepList(props) {
      if (!props.loaded) return h("div", { style: styles.panel }, h("div", { style: styles.empty }, "读取轨迹…"));
      if (props.steps.length === 0) {
        return h("div", { style: styles.panel }, h("div", { style: styles.empty }, "没有可显示的步骤。"));
      }
      return h(
        "div",
        { style: styles.panel },
        ...props.steps.map((step, index) =>
          h(
            "div",
            { key: `${step.kind}-${step.step}-${index}`, style: styles.step },
            h(
              "div",
              { style: styles.stepHead },
              h("span", { style: styles.stepNo }, `#${step.step}`),
              h("span", { style: styles.stepTitle }, step.title),
            ),
            step.body === "" ? null : h("div", { style: styles.stepBody }, h("pre", { style: styles.pre }, step.body)),
            step.detail === ""
              ? null
              : h(
                  "details",
                  { style: { margin: "6px 0 0 36px", color: C.muted, fontSize: 11 } },
                  h("summary", null, step.kind === "tool" ? "参数" : "推理"),
                  h("pre", { style: { ...styles.pre, maxHeight: 220, marginTop: 6 } }, step.detail),
                ),
          ),
        ),
      );
    }

    /**
     * The Reverie settings card.
     * @returns {any} element.
     */
    function ReveriePanel() {
      const [theme, setTheme] = react.useState("archive");
      const [runs, setRuns] = react.useState(null);
      const [runId, setRunId] = react.useState("");
      const [meta, setMeta] = react.useState(null);
      const [corpus, setCorpus] = react.useState(null);
      const [tab, setTab] = react.useState("trail");
      const [files, setFiles] = react.useState({});
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState(false);

      const loadRuns = react.useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          const body = await getJson(`${API.runs}?limit=30`);
          setRuns(body.runs ?? []);
          setRunId((current) => (current === "" && body.runs?.length > 0 ? body.runs[0].runId : current));
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
          setRuns([]);
        } finally {
          setBusy(false);
        }
      }, []);

      react.useEffect(() => {
        loadRuns();
        getJson(API.corpus)
          .then((body) => setCorpus(body))
          .catch(() => setCorpus(null));
      }, [loadRuns]);

      react.useEffect(() => {
        if (runId === "") return;
        let cancelled = false;
        setMeta(null);
        setFiles({});
        getJson(`${API.run}?id=${encodeURIComponent(runId)}`)
          .then((body) => {
            if (!cancelled) setMeta(body.meta ?? null);
          })
          .catch((failure) => {
            if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
          });
        getJson(`${API.file}?id=${encodeURIComponent(runId)}&name=trail`)
          .then((body) => {
            if (!cancelled) setFiles((current) => ({ ...current, trail: body.content ?? "" }));
          })
          .catch(() => {
            if (!cancelled) setFiles((current) => ({ ...current, trail: "" }));
          });
        return () => {
          cancelled = true;
        };
      }, [runId]);

      react.useEffect(() => {
        if (runId === "" || meta === null) return;
        if (tab !== "report" && tab !== "handoff") return;
        if (files[tab] !== undefined) return;
        let cancelled = false;
        getJson(`${API.file}?id=${encodeURIComponent(runId)}&name=${tab}`)
          .then((body) => {
            if (!cancelled) setFiles((current) => ({ ...current, [tab]: body.content ?? "" }));
          })
          .catch((failure) => {
            if (!cancelled) {
              setFiles((current) => ({
                ...current,
                [tab]: `读取失败：${failure instanceof Error ? failure.message : String(failure)}`,
              }));
            }
          });
        return () => {
          cancelled = true;
        };
      }, [runId, tab, meta, files]);

      const trailLoaded = files.trail !== undefined;
      const steps = trailLoaded ? parseTrail(files.trail) : [];
      const evidence = trailLoaded ? collectEvidence(steps) : [];
      const usage = meta?.usage ?? {};
      const corpusMeta = meta?.corpus ?? {};
      const touched = Array.isArray(meta?.touched) ? meta.touched : [];
      const total = corpus?.documents ?? corpusMeta.documents ?? 0;
      const percent = total > 0 ? ((touched.length / total) * 100).toFixed(2) : "0.00";

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.head },
          h(
            "div",
            null,
            h("div", { style: styles.eyebrow }, "REVERIE / 夜路手记"),
            h("h2", { style: styles.title }, "Reverie 旅程"),
          ),
          h("span", { style: styles.badge }, "本地 · 只读"),
          h("span", { style: { flex: 1 } }),
          h(
            "button",
            { type: "button", style: styles.themeButton(theme === "archive"), onClick: () => setTheme("archive") },
            "采样",
          ),
          h("button", { type: "button", style: styles.themeButton(theme === "road"), onClick: () => setTheme("road") }, "路书"),
        ),
        h(
          "div",
          { style: styles.row },
          h(
            "select",
            {
              style: styles.select,
              value: runId,
              onChange: (event) => setRunId(event.target.value),
              "aria-label": "选择旅程",
            },
            (runs ?? []).length === 0
              ? h("option", { value: "" }, "还没有运行记录")
              : (runs ?? []).map((run) =>
                  h("option", { key: run.runId, value: run.runId }, `${run.runId} · ${run.mode} · ${run.stopReason}`),
                ),
          ),
          h("button", { type: "button", style: styles.button, onClick: loadRuns, disabled: busy }, busy ? "读取中…" : "刷新"),
        ),
        error === "" ? null : h("div", { style: styles.error }, error),
        meta === null
          ? h("div", { style: styles.empty }, runs === null ? "读取运行记录…" : "选择一个旅程查看报告。")
          : h(
              "div",
              null,
              h(
                "div",
                { style: styles.stats },
                h(Stat, { label: "模式", value: String(meta.mode ?? "—") }),
                h(Stat, { label: "结束原因", value: String(meta.stop_reason ?? "—") }),
                h(Stat, { label: "步骤", value: String(usage.steps ?? "—") }),
                h(Stat, { label: "tokens", value: `${usage.input ?? 0} / ${usage.output ?? 0}` }),
                h(Stat, { label: "点亮", value: `${touched.length} / ${total}（${percent}%）` }),
              ),
              theme === "archive"
                ? h(
                    "div",
                    null,
                    h(DensityStrip, { corpus, touched }),
                    h(
                      "div",
                      { style: { ...styles.row, color: C.muted, fontSize: 10 } },
                      "这趟碰过的语料只占全库的一小部分；琥珀色是它真正读到的地方。",
                    ),
                    h(StepList, { steps, loaded: trailLoaded }),
                    h(
                      "div",
                      { style: styles.panel },
                      h("div", { style: { color: C.muted, fontSize: 10, marginBottom: 6 } }, "私人纸条 / PRIVATE NOTE"),
                      h("pre", { style: styles.pre }, files.handoff ?? "在「纸条」标签页读取。"),
                    ),
                  )
                : null,
              h(
                "div",
                { style: styles.row },
                ...TABS.map(([key, label]) =>
                  h("button", { key, type: "button", style: styles.tab(tab === key), onClick: () => setTab(key) }, label),
                ),
              ),
              tab === "trail" ? h(StepList, { steps, loaded: trailLoaded }) : null,
              tab === "evidence"
                ? h(
                    "div",
                    { style: styles.panel },
                    evidence.length === 0
                      ? h("div", { style: styles.empty }, "这一趟没有留下可引用的 locator。")
                      : evidence.map((item) =>
                          h(
                            "div",
                            { key: item.locator, style: styles.step },
                            h("div", { style: styles.locator }, item.locator),
                            h("pre", { style: { ...styles.pre, maxHeight: 120, marginTop: 6 } }, item.snippet),
                          ),
                        ),
                  )
                : null,
              tab === "report" || tab === "handoff"
                ? h("div", { style: styles.panel }, h("pre", { style: styles.pre }, files[tab] === undefined ? "读取中…" : files[tab]))
                : null,
            ),
      );
    }

    /** Required client services. */
    const inject = ["slots"];

    /**
     * Register the settings section.
     * @param {any} ctx - client context.
     * @returns {void}
     */
    function apply(ctx) {
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "reverie",
              order: 337,
              label: () => "Reverie",
            },
            ReveriePanel,
          ),
        );
      } catch (error) {
        console.warn("[dsh-reverie] settings panel registration failed:", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ReveriePanel = ReveriePanel;
    return exports;
  },
});
