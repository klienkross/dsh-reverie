# dsh-reverie

English | [中文](README.zh.md)

Reverie is an **isolated, read-only, open-ended association experiment** for DeepSeek Harness. Point it at a corpus — a folder of notes, a JSON/JSONL export, your own session history — let a model pick its own topic, search, expand originals and follow an association as far as it wants, and it leaves exactly two things behind: a report and a bounded private note.

It is not a task system and not a profile generator. Wandering, dead ends and "this trip produced nothing" are all valid outcomes.

```text
reverie_status    sources, corpus size and model route at a glance
reverie_sources   the corpus sources and their groups
reverie_search    lexical search, returning <source>/<inner> evidence locators
reverie_read      expand one locator back into its text
reverie_run       run one trip (mock by default, no model call)
reverie_report    read back a report / note / trail
reverie_config    inspect or change runtime settings and `sources`
```

## Why a plugin

The original Reverie lived inside a private companion system, where its corpus was that system's memory layers and its only user was one person. As a DSH plugin the mechanism is reused, but the corpus is whatever you configure:

- a **folder** of markdown/txt notes (an Obsidian vault, a journal directory, exported notes);
- a **JSON/JSONL** export (a read-later queue, bookmarks, journal lines);
- the harness's own **session history** (persisted, non-live sessions only).

Each trip is read-only, writes nothing back to any store, and leaves artifacts under `~/.dsh/reverie/runs/`. `mock` mode needs no API key: install it, inspect a real artifact, then decide whether to spend tokens.

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

## Quick start

1. `reverie_status` — see which sources are mounted and how many documents they contribute.
2. Configure a source with `reverie_config` (or edit `~/.dsh/reverie/config.json`):

```jsonc
"sources": [
  { "id": "notes",   "kind": "folder", "root": "D:/notes", "extensions": ["md", "txt"] },
  { "id": "journal", "kind": "json",   "path": "D:/data/journal.jsonl" }
]
```

With no `sources` configured, the corpus is your current workspace's session history.

3. `reverie_run` — run one mock trip. No model is called; this exercises the corpus, the ranking, the artifact writer and the report shape.
4. `reverie_report` — read the generated report and `handoff.md`.
5. To do it for real, set `mode: "live"` with `reverie_config` (or pass `live: true` to one call) and run again. That spends API budget.

## Panel

Once installed, the web surface gets a **Reverie** section: a run picker, run stats, and four tabs — report, private note, step trail, evidence locators. It is a viewer: the routes behind it only list and read recorded runs, so a page refresh can never start a trip or spend budget.

The visual language is ported from the original Reverie night-atlas page. The atlas map itself (waypoints on a winding road) is the next porting step; the panel already carries the journey/stats/trail structure it will feed.

## Sources

| kind | reads | locator shape |
|---|---|---|
| `folder` | markdown/txt files under `root`, split at headings, oversized sections chunked at paragraph boundaries | `notes/dir/note.md#L12-L40` |
| `json` | a `.json` (array, or one group per array-valued key) or `.jsonl` file; text/title/time fields configurable | `journal/entries#3` |
| `dsh-sessions` | persisted, non-live DSH sessions in this workspace (or all workspaces with `scope: "all"`) | `dsh/session-id#96` |

A single source that fails only contributes a problem line; the rest of the corpus still loads.

## Data and privacy

- **Read-only**: nothing is appended to, rewritten in, or deleted from any session, note, memory store or export.
- **Only what people said** (session source): harness-injected context (workspace instructions, runtime snapshots, skill catalog) is excluded by `source.kind`; reasoning and tool traffic never become corpus text.
- **Closed sessions only**: the live conversation you are in is excluded; it can never become its own experiment material.
- **No network beyond the model call**: no telemetry, no uploads, no third-party requests; `mock` is fully offline.
- **Artifacts**: `$DSH_HOME/reverie/runs/<date>/<run-id>/{run.json,report.md,handoff.md,events.jsonl,usage.json}` plus `latest.json`. Settings live in `$DSH_HOME/reverie/config.json`.
- **Reports and notes are model-generated** (live runs), not authoritative memory. Expand the `<source>/<inner>` locator before believing a claim.

## Settings

```jsonc
{
  "sources": [],            // corpus; empty = session history for this workspace
  "scope": "workspace",     // default session source: workspace | all
  "includeSubagents": false,
  "maxSessions": 24,
  "lookbackDays": 0,
  "maxDocuments": 4000,
  "minDocumentChars": 24,
  "cacheTtlMs": 600000,
  "provider": "",           // empty = first registered provider
  "model": "",              // empty = that provider's first advertised model
  "reasoningEffort": "",
  "mode": "mock",           // mock costs nothing; live spends API budget
  "maxSteps": 8,
  "maxInputTokens": 60000,
  "maxOutputTokens": 2048,
  "timeoutMs": 600000,
  "maxNoteChars": 2000,
  "persona": "",
  "language": "zh"
}
```

Folder-specific: `extensions`, `exclude`, `maxFileBytes`, `maxDocChars` per entry.
JSON-specific: `textFields` (default `text`, `content`, `note`, `body`, …), `titleField`, `timeField`.

## Compatibility

| Item | Requirement |
|---|---|
| DSH | `>= 0.1.5-rc.1`; developed and tested on the 0.2.0-rc.2 desktop build |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Host services | `tools` and `systemPrompt` are required; `llm` (live runs) and `sessionQuery` (session source) are optional — a folder-only composition works without either |
| Peers | `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm` |

## Architecture

```text
sources/{folder,json,dsh}.js ──► corpus.js ──► search.js ──► loop.js ──► artifacts.js
 (normalized documents)         (locators, caps)  (BM25 + CJK) (tool loop)   (runs/ output)
                                                      │
                                                mock.js (deterministic)
```

- `lib/sources/*` adapters return flat documents with stable locators; adding a store type is one `create*Source` function plus a `SOURCE_KINDS` entry. The ranking, the loop and the artifact writer never learn where the text came from.
- `lib/corpus.js` mounts sources, prefixes locators with the source id, applies caps and caches the snapshot.
- `lib/search.js` is host-free: latin words plus CJK characters and bi-grams, BM25, literal-phrase bonus.
- `lib/loop.js` is Reverie's own model loop: streamed steps, block assembly, inner `reverie_search` / `reverie_read` / `reverie_note`, budget stop reasons.
- `lib/artifacts.js` / `lib/runs.js` write and read run artifacts through a validated id allowlist.

Design choices:

- **A corpus source, not a session scraper**: Reverie's mechanism is about flat, heterogeneous personal data; the session history is only one adapter.
- **`ctx.sessionQuery`, not hand-parsed logs**: the session adapter stays format-agnostic and replay-validated.
- **No reuse of the host agent loop**: Reverie owns its messages and budget without occupying the daily conversation.
- **`mock` is a first-class mode**: anyone can verify the whole pipeline without an API key.

## Development

```sh
npm install
npm test              # in-process runner (works in restricted sandboxes)
npm run test:isolated # one child process per file (requires spawning)
```

## Roadmap

- The night-atlas map: port the original winding-road layout onto this plugin's trail events.
- SQL sources (`node:sqlite`, read-only, single `SELECT`/`WITH`).
- A standalone CLI reusing the host-free core, so other harnesses can run the same trips.
- Optional evaluation loop: marking notes as worth-following or not, so the mechanism gets evidence instead of anecdotes.

MIT License.
