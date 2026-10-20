# dsh-reverie

English | [中文](README.zh.md)

Reverie is an **isolated, read-only, open-ended association experiment** for DeepSeek Harness. It treats your own persisted session history as its corpus, lets a model pick its own topic, search, expand originals and follow an association as far as it wants, and leaves exactly two things behind: a report and a bounded private note.

It is not a task system and not a profile generator. Wandering, dead ends and "this trip produced nothing" are all valid outcomes.

```text
reverie_status    config, corpus and model route at a glance
reverie_sessions  which sessions this run would read
reverie_search    lexical search, returning <sessionId>#<seq> evidence locators
reverie_read      expand one locator into the original window
reverie_run       run one trip (mock by default, no model call)
reverie_report    read back a report / note / trail
reverie_config    inspect or change runtime settings
```

## Why a plugin

The original Reverie lived inside a private companion system, where its corpus was that system's memory layers and its only user was one person. As a DSH plugin:

- the corpus becomes **any DSH user's own session history**, so it works the moment it is installed;
- each trip still owns its messages, reads the corpus read-only, and writes nothing back to memory — artifacts go under `~/.dsh/reverie/runs/`;
- `mock` mode needs no API key at all: install it, inspect a real artifact, then decide whether to spend tokens.

## Install

DSH Desktop: install `@kleinkross/dsh-reverie` from **Settings → Plugins**.

CLI:

```sh
dsh plugin --profile web add @kleinkross/dsh-reverie
```

Local development (works before publishing):

```sh
dsh plugin --profile web add /path/to/dsh-reverie
```

The installer adds the package to your profile's bundle list; restart `dsh web` (or let HMR pick it up) and the tools appear.

## Quick start

1. `reverie_status` — confirm the corpus is non-empty, a model route is available, and the mode is `mock`.
2. `reverie_run` — run one mock trip. No model is called; this exercises the corpus, the ranking, the artifact writer and the report shape.
3. `reverie_report` — read the generated report and `handoff.md`.
4. To do it for real, set `mode: "live"` with `reverie_config` (or pass `live: true` to one call) and run again. That spends API budget.

Check `reverie_sessions` before the first real run: it shows exactly which sessions the current `scope` would read.

## Data and privacy

- **Read-only**: nothing is appended to, rewritten in, or deleted from any session, memory store or corpus file.
- **Closed sessions only**: the live conversation you are in is excluded; it can never become its own experiment material.
- **Current workspace by default**: `scope: "workspace"`; set `"all"` to read every local workspace.
- **No network beyond the model call**: no telemetry, no uploads, no third-party requests; `mock` is fully offline.
- **Artifacts**: `$DSH_HOME/reverie/runs/<date>/<run-id>/{run.json,report.md,handoff.md,events.jsonl,usage.json}` plus `latest.json`. Settings live in `$DSH_HOME/reverie/config.json`.
- **Reports and notes are model-generated** (live runs), not authoritative memory. Expand the `<sessionId>#<seq>` locator before believing a claim.

## Settings

```jsonc
{
  "scope": "workspace",     // workspace | all
  "includeSubagents": false,// subagent sessions stay out of the corpus by default
  "maxSessions": 24,        // persisted sessions read per trip
  "lookbackDays": 0,        // 0 = no time limit
  "maxDocuments": 4000,     // message ceiling
  "minDocumentChars": 24,   // shorter messages never enter the corpus
  "cacheTtlMs": 600000,     // corpus cache lifetime
  "provider": "",           // empty = first registered provider
  "model": "",              // empty = that provider's first advertised model
  "reasoningEffort": "",
  "mode": "mock",           // mock costs nothing; live spends API budget
  "maxSteps": 8,
  "maxInputTokens": 60000,  // cumulative input ceiling (provider usage when reported)
  "maxOutputTokens": 2048,
  "timeoutMs": 600000,
  "maxNoteChars": 2000,
  "persona": "",            // optional persona/voice file path
  "language": "zh"          // report and prompt language: zh | en
}
```

Change it through `reverie_config` or by editing the JSON file; every call re-reads it, and invalid fields are rejected and reported instead of being silently ignored.

## Compatibility

| Item | Requirement |
|---|---|
| DSH | `>= 0.1.5-rc.1`; developed and tested on the 0.2.0-rc.2 desktop build |
| Node | `^22.19.0 || >=24.0.0` |
| Host services | `tools` and `systemPrompt` are required; when `sessionQuery` (corpus) or `llm` (live runs) are missing the plugin still mounts and the tools say what is absent |
| Peers | `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm` |

## Architecture

```text
ctx.sessionQuery ──► corpus.js ──► search.js ──► loop.js ──► artifacts.js
 (read-only corpus)  (normalized)   (BM25 + CJK)  (tool loop)   (runs/ output)
                                        │
                                  mock.js (deterministic, no model call)
```

- `lib/index.js` only assembles: register the tools and the system-prompt announcement.
- `lib/corpus.js` reads through `ctx.sessionQuery`, keeping persisted non-live sessions only; one unreadable session is reported as a problem instead of erasing the corpus.
- `lib/search.js` is host-free: latin words plus CJK characters and bi-grams, BM25, literal-phrase bonus. The same corpus and query always rank the same way.
- `lib/loop.js` is Reverie's own model loop: one streamed step at a time, block assembly, inner tool dispatch (`reverie_search` / `reverie_read` / `reverie_note`). Budget exhaustion is reported as `budget` / `max-steps`, never dressed up as the model deciding to finish.
- `lib/artifacts.js` writes runs; `lib/runs.js` reads them only through a validated run id and a fixed file allowlist.
- `lib/tools.js` is the model-facing surface.

Design choices:

- **`ctx.sessionQuery`, not hand-parsed `.jsonl.zstd`**: the corpus must be the model-visible history itself, and the plugin should not carry storage-format knowledge.
- **No reuse of the host agent loop**: Reverie's experiment identity requires owning its messages and budget without occupying the daily conversation.
- **`mock` is a first-class mode**: anyone can verify the whole pipeline without an API key, and the regression suite costs nothing.

## Development

```sh
npm install
npm test              # in-process runner (works in restricted sandboxes)
npm run test:isolated # one child process per file (requires spawning)
```

The suite covers config validation, corpus filtering and caching, BM25 ranking and phrase bonus, loop tool dispatch / budgets / errors, mock determinism, and every tool end-to-end including one live run against a fake model route.

## Scope and limits

- The corpus is read-only; the plugin never writes back to memory, session logs or compaction state.
- Tools live in the agent's tool table only. There is no background scheduler: when a trip happens is up to the human and the model.
- Live cost is determined by the host's provider. Budgets here are pre-checks (steps and token ceilings), not a hard billing limit.
- A report or note may be quoted by later conversation or a subagent, but it is not evidence. Evidence is always the original text behind a locator.

MIT License.
