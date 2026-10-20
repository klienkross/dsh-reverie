# dsh-reverie

[English](README.md) | 中文

Reverie 是 DeepSeek Harness 里的一次**独立、只读、开放式的联想实验**：给它一个语料源——笔记目录、JSON/JSONL 导出、或者你自己的会话历史——让模型自己选主题、检索、展开原文、任联想走下去，最后只留下两样东西：一份报告和一张有界的私人纸条。

它不是待办系统，也不是画像生成器。允许走神、允许死路、允许「这一趟没有发现」。

```text
reverie_status    源、语料规模、模型线路一眼看完
reverie_sources   列出声明的源与分组
reverie_search    词法检索，返回 <源>/<内部定位> 证据 locator
reverie_read      按 locator 展开原文
reverie_run       跑一趟（默认 mock，不调用模型）
reverie_report    回看报告 / 纸条 / 轨迹
reverie_config    查看或修改运行设置与 `sources`
```

## 为什么是插件

Reverie 的原始实现长在一个私人陪伴系统里：语料是那个系统的记忆层，用户只有一个。做成 DSH 插件之后机制保留，但语料变成可配置的：

- **folder**：一个 markdown/txt 目录（Obsidian 库、日记目录、导出的笔记）；
- **json**：JSON / JSONL 导出（稍后读队列、书签、逐日记录）；
- **dsh-sessions**：Harness 自己的会话历史（只读已关闭的会话）。

每趟运行只读、不写回任何存储，产物落在 `~/.dsh/reverie/runs/`。`mock` 模式完全不需要 API key：先装、先看产物，再决定要不要花 token。

## 安装

DSH Desktop：**设置 → 插件**里安装 `@kleinkross/dsh-reverie`。

CLI：

```sh
dsh plugin --profile web add @kleinkross/dsh-reverie
```

本地开发（不发布也能装）：

```sh
dsh plugin --profile web add /path/to/dsh-reverie
```

## 快速开始

1. `reverie_status` —— 看哪些源挂上了、各自贡献多少文档。
2. 用 `reverie_config` 配一个源（或直接编辑 `~/.dsh/reverie/config.json`）：

```jsonc
"sources": [
  { "id": "notes",   "kind": "folder", "root": "D:/notes", "extensions": ["md", "txt"] },
  { "id": "journal", "kind": "json",   "path": "D:/data/journal.jsonl" }
]
```

不配置 `sources` 时，语料默认是本工作区的会话历史。

3. `reverie_run` —— 跑一趟 mock。不调用模型，只验证语料、检索、产物写入与报告形状。
4. `reverie_report` —— 读报告与 `handoff.md`。
5. 想真跑：`reverie_config` 设 `mode: "live"`（或在调用时传 `live: true`），再跑一次。会产生 API 费用。

## 语料源

| kind | 读什么 | locator 形状 |
|---|---|---|
| `folder` | `root` 下的 markdown/txt，按标题切 section，超长段按段落切块 | `notes/dir/note.md#L12-L40` |
| `json` | `.json`（数组，或每个数组键一组）或 `.jsonl`；文本/标题/时间字段可配 | `journal/entries#3` |
| `dsh-sessions` | 本工作区（或 `scope: "all"` 的全部）已持久化、非活跃会话 | `dsh/session-id#96` |

单个源失败只贡献一条问题记录，其余源照常加载。

## 数据与隐私

- **只读**：从不写入、追加或改写任何会话、笔记、memory 或导出文件。
- **只收「人说过的话」**（会话源）：宿主注入的上下文（AGENTS.md、运行时快照、技能目录）按 `source.kind` 排除；推理与工具流量不进语料。
- **只读已关闭的会话**：当前活跃会话被排除，正在进行的对话不会成为实验材料。
- **不联网，除了模型本身**：没有遥测、没有上传、没有第三方请求；`mock` 完全离线。
- **产物**：`$DSH_HOME/reverie/runs/<日期>/<run-id>/{run.json,report.md,handoff.md,events.jsonl,usage.json}` 与 `latest.json`；配置在 `$DSH_HOME/reverie/config.json`。
- **报告与纸条是模型生成材料**（live），不是权威记忆。相信结论之前，按 `<源>/<内部定位>` 展开原文。

## 运行设置

```jsonc
{
  "sources": [],            // 语料；空 = 本工作区会话历史
  "scope": "workspace",     // 默认会话源的范围：workspace | all
  "includeSubagents": false,
  "maxSessions": 24,
  "lookbackDays": 0,
  "maxDocuments": 4000,
  "minDocumentChars": 24,
  "cacheTtlMs": 600000,
  "provider": "",           // 空 = 第一个已注册 provider
  "model": "",              // 空 = 该 provider 的第一个模型
  "reasoningEffort": "",
  "mode": "mock",           // mock 不花钱；live 产生费用
  "maxSteps": 8,
  "maxInputTokens": 60000,
  "maxOutputTokens": 2048,
  "timeoutMs": 600000,
  "maxNoteChars": 2000,
  "persona": "",
  "language": "zh"
}
```

folder 专属：`extensions`、`exclude`、`maxFileBytes`、`maxDocChars`。
json 专属：`textFields`（默认 `text`/`content`/`note`/`body`…）、`titleField`、`timeField`。

## 兼容性

| 项目 | 要求 |
|---|---|
| DSH | `>= 0.1.5-rc.1`；已在 0.2.0-rc.2 桌面版开发与测试 |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 宿主服务 | `tools`、`systemPrompt` 必需；`llm`（live 运行）与 `sessionQuery`（会话源）可选——只配 folder 时两者都不需要 |
| 依赖包 | peer：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm` |

## 实现概览

```text
sources/{folder,json,dsh}.js ──► corpus.js ──► search.js ──► loop.js ──► artifacts.js
 （归一化文档）                  （locator/上限）  （BM25+CJK）  （工具循环）   （runs/ 产物）
                                                      │
                                                mock.js（确定性，不调模型）
```

- `lib/sources/*` 适配器只负责把某个存储变成扁平文档；加一种存储 = 一个 `create*Source` 函数 + `SOURCE_KINDS` 里加一项。排序、循环、产物写入完全不知道文本来自哪里。
- `lib/corpus.js` 挂载源、给 locator 加源前缀、应用上限并缓存快照。
- `lib/search.js` 与宿主无关：拉丁词 + CJK 二元切词、BM25、字面短语加权。
- `lib/loop.js` 是 Reverie 自己的模型循环：流式步进、block 组装、内部工具（`reverie_search`/`reverie_read`/`reverie_note`）、预算停止原因。
- `lib/artifacts.js` / `lib/runs.js` 只按白名单 id 与固定文件名写读产物。

设计取舍：

- **做语料源，不做会话抓取器**：Reverie 的机制面向扁平、异构的个人数据，会话历史只是其中一个 adapter。
- **会话源仍走 `ctx.sessionQuery`**：不携带存储格式知识，读取是重放校验过的。
- **不复用宿主 agent loop**：实验身份要求它拥有自己的消息与预算，不占用日常会话。
- **`mock` 是一等公民**：没有 API key 也能验证整条链路。

## 开发与测试

```sh
npm install
npm test              # 进程内运行（受限沙箱可用）
npm run test:isolated # 每个文件一个子进程（需要可 spawn）
```

## Roadmap

- SQL 源（`node:sqlite`，只读、单条 `SELECT`/`WITH`）——下一步。
- 独立 CLI，复用 host-free 核心，让其他 harness 也能跑同样的旅程。
- 可选的评估闭环：给纸条标「值得跟 / 没用」，让机制积累证据而不是轶事。

MIT License。
