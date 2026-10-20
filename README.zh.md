# dsh-reverie

[English](README.md) | 中文

Reverie 是 DeepSeek Harness 里的一次**独立、只读、开放式的联想实验**：它把本机已经持久化的会话历史当作语料，让模型自己选一个主题，检索、展开原文、任联想走下去，最后只留下两样东西——一份报告和一张有界的私人纸条。

它不是待办系统，也不是画像生成器。允许走神、允许死路、允许「这一趟没有发现」。

```text
reverie_status    配置、语料、模型线路，一眼看完
reverie_sessions  这次会读到哪些会话
reverie_search    词法检索，返回 <sessionId>#<seq> 证据 locator
reverie_read      按 locator 展开原文窗口
reverie_run       跑一趟（默认 mock，不调用模型）
reverie_report    回看报告 / 纸条 / 轨迹
reverie_config    查看或修改运行设置
```

## 为什么是插件

Reverie 的原始实现长在一个私人陪伴系统里：语料是那个系统的 L1/L2/L3 记忆，用户只有一个。做成 DSH 插件之后：

- 语料换成**任何 DSH 用户自己的会话历史**，装完即有料，不需要先部署另一套系统；
- 每次运行仍然独立、只读、不写回任何记忆，产物只落在 `~/.dsh/reverie/runs/`；
- `mock` 模式完全不需要 API key，任何人可以先装、先看产物形状，再决定要不要花 token。

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

安装后需要在 profile 里启用该组合包（插件市场/插件页会把它加进 `dsh.profile.bundles`），然后重启 `dsh web` 或等 HMR 生效。

## 快速开始

1. `reverie_status` —— 确认语料非空、模型线路可用、当前是 `mock`。
2. `reverie_run` —— 跑一趟 mock。它**不会**调用模型，只是把语料、排序、产物写入和报告形状走一遍。
3. `reverie_report` —— 读刚生成的报告或 `handoff.md`。
4. 想真跑：`reverie_config` 设 `mode: "live"`（或在 `reverie_run(live: true)` 时临时打开），再跑一次。这一步会产生 API 费用。

第一次跑之前建议先看一眼 `reverie_sessions`：确认 `scope` 选到的是你想让它读的那些会话。

## 数据与隐私

- **只读**：从不写入、追加或改写任何会话、memory、语料文件。
- **只读已关闭的会话**：当前活跃（live）的会话被排除，正在进行的对话不会成为实验材料。
- **默认只读本工作区**：`scope: "workspace"`；改成 `"all"` 才会跨工作区读取。
- **不联网，除了模型本身**：没有遥测、没有上传、没有第三方请求；`mock` 模式完全离线。
- **产物**：`$DSH_HOME/reverie/runs/<日期>/<run-id>/{run.json,report.md,handoff.md,events.jsonl,usage.json}` 与 `latest.json`；配置在 `$DSH_HOME/reverie/config.json`。
- **报告与纸条是模型生成材料**（live 运行），不是权威记忆。相信任何结论之前，按报告里的 `<sessionId>#<seq>` 展开原文。

## 运行设置

```jsonc
{
  "scope": "workspace",     // workspace | all
  "includeSubagents": false,// 子代理会话默认不进语料
  "maxSessions": 24,        // 每次最多读多少个已持久化会话
  "lookbackDays": 0,        // 0 = 不限时间
  "maxDocuments": 4000,     // 消息条数上限
  "minDocumentChars": 24,   // 太短的消息不进语料
  "cacheTtlMs": 600000,     // 语料缓存寿命
  "provider": "",           // 空 = 用第一个已注册的 provider
  "model": "",              // 空 = 用该 provider 的第一个模型
  "reasoningEffort": "",
  "mode": "mock",           // mock 不调用模型；live 会产生费用
  "maxSteps": 8,
  "maxInputTokens": 60000,  // 累计输入上限（provider 有 usage 时按 usage 计）
  "maxOutputTokens": 2048,
  "timeoutMs": 600000,
  "maxNoteChars": 2000,
  "persona": "",            // 可选：身份/文风参考文件路径
  "language": "zh"          // 报告与提示语言：zh | en
}
```

用 `reverie_config` 改，也可直接编辑 `$DSH_HOME/reverie/config.json`（每次调用都会重新读取，非法字段会被拒绝并出现在返回里）。

## 支持矩阵

| 项目 | 要求 |
|---|---|
| DSH | `>= 0.1.5-rc.1`；已在 0.2.0-rc.2 桌面版上开发与测试 |
| Node | `^22.19.0 || >=24.0.0` |
| 宿主服务 | `tools`、`systemPrompt` 必需；`sessionQuery`（语料）、`llm`（live 运行）缺失时插件仍会挂载，工具会明确说明缺什么 |
| 依赖包 | peer：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm` |

## 实现概览

```text
ctx.sessionQuery ──► corpus.js ──► search.js ──► loop.js ──► artifacts.js
 (只读语料)          (归一化文档)   (BM25+CJK)   (工具循环)    (runs/ 产物)
                                        │
                                  mock.js（确定性，不调模型）
```

- `lib/index.js` 只做装配：注册工具与系统提示公告。
- `lib/corpus.js` 通过 `ctx.sessionQuery` 读语料，只收 persisted 且非 live 的会话；单个会话读失败只记录问题，不吞掉整份语料。
- `lib/search.js` 是与宿主无关的检索：拉丁词 + CJK 二元切词、BM25、字面短语加权。同一份语料与查询永远排出同样的顺序。
- `lib/loop.js` 是 Reverie 自己的模型循环：每次一步流式请求、组装 blocks、派发内部工具（`reverie_search` / `reverie_read` / `reverie_note`），预算耗尽会被记成 `budget` / `max-steps`，而不是伪装成模型主动结束。
- `lib/artifacts.js` 负责产物；`lib/runs.js` 只按白名单 id 与固定文件名读取，模型给的 `run` 参数不能穿出目录。
- `lib/tools.js` 是模型可见的七个工具。

设计取舍：

- **用 `ctx.sessionQuery` 而不是自己解 `.jsonl.zstd`**：语料必须是模型可见的历史本身，而不是二次解析；也让插件不携带存储格式知识。
- **不复用宿主 agent loop**：Reverie 的实验身份要求它拥有自己的消息与预算，不占用、也不污染日常会话。
- **`mock` 是一等公民**：没有 API key 的人也能验证整条链路，回归测试也不烧钱。

## 开发与测试

```sh
npm install
npm test              # 进程内运行（受限沙箱可用）
npm run test:isolated # 每个文件一个子进程（需要可 spawn）
```

测试覆盖：配置校验、语料过滤与缓存、BM25 排序与短语加权、循环的工具派发/预算/错误、mock 确定性、七个工具的端到端（含一次 live 运行，模型线路是假的）。

## 参考与边界

- 语料只读、不写回记忆、不触发压缩或轮转。
- 工具只排在 agent 的工具表里；插件不注册任何后台定时任务，跑不跑由人和模型决定。
- `live` 运行的花费由宿主的 provider 决定；插件只做费用预检（步数与 token 上限），不是硬账单限额。
- 报告与纸条可以被子代理或被后续对话引用，但它们不是证据；证据永远是 locator 指向的原文。

MIT License。
