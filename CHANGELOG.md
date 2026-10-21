# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-10-21

Diagnosable, fault-isolated mounting.

### Added

- Every mount step (tools, panel routes, announcement) is now attempted
  independently: one failing part no longer removes the whole plugin. Tool
  registration is isolated per tool, and route registration per route.
- Mount outcomes are appended to `$DSH_HOME/reverie/apply-error.log`: an
  `apply-ok` line on success, and a timestamped message plus stack for each
  failure. The host GUI surfaces no plugin load error, so this file is the
  diagnostic surface. A missing file after a restart means the module never
  evaluated at all (import/resolution failure).

## [0.4.1] - 2026-10-21

Fixes the plugin failing to load once a web panel was declared.

### Fixed

- `lib/client.js` no longer touches `window.__ModuleLoader__` unconditionally: a
  Node-side import (boot validation, a mistaken host import, a tool) used to
  throw `ReferenceError: window is not defined`, which made the whole bundle
  fail and removed every `reverie_*` tool from the host.
- `package.json` now exports `"./client": "./lib/client.js"`, so the client
  loader resolves the panel entry by its documented subpath instead of falling
  back to the host entry.

## [0.4.0] - 2026-10-21

A second theme: the sampling view.

### Added

- **`archive` theme (default)**: the whole corpus as a dim daily density strip
  with the documents this trip actually touched lit in amber, a
  `点亮 N / total (x%)` stat, the step trail, and the private note as a closing
  card. The claim it makes is the honest one — most of the archive stays dark.
- **`road` theme**: the previous journey/stats/tabs view, kept as a switchable
  alternative.
- `/api/dsh-reverie/corpus`: a read-only daily histogram of the configured
  corpus (documents, sources, day buckets, span) for the strip.
- `run.json` now records `touched: [{locator, time}]` — locators cited by tool
  results or the final note — so the viewer lights exactly what the trip kept
  instead of re-deriving it from free text.
- The panel fetches the trail as soon as a run is selected, so the sampling view
  never starts empty.

## [0.3.0] - 2026-10-21

The first web panel, ported from the original Reverie frontend.

### Added

- A **Reverie** settings section in the web client: run picker, run stats, and
  four tabs — report, private note, step trail, evidence locators. Registered
  through the client module loader (`slots.inject("settings.section")`), no
  build step.
- Read-only viewer routes under `/api/dsh-reverie/`: `runs` (list), `run`
  (metadata), `file` (report / handoff / trail / usage / meta artifacts).
  Loopback-only, GET-only, artifact-name allowlist, 1 MiB response ceiling.
- The panel is a viewer by construction: there is no route that starts a run,
  so a page refresh can never spend model budget.
- Panel routes mount only when the host provides a web server; headless
  compositions keep the tools and skip the UI.

## [0.2.1] - 2026-10-21

Fixes from the first live runs over a real notes vault.

### Fixed

- A trip that runs out of steps while still reading now gets one dedicated
  finalize request: only the note tool is offered, and the trail records a
  `finalize` event. Before this, hitting `max-steps` meant the run produced no
  private note at all.
- `reverie_read` inside a run no longer fails on a locator the model extended or
  shortened: an overlapping section is returned, a range outside every section
  falls back to the nearest one (with a note), and a bare file path reads that
  file's sections. Only genuinely absent material fails, and the failure lists
  nearby candidates.
- The prompt now tells the model to copy locator strings verbatim and that a
  path without a line range is acceptable.

## [0.2.0] - 2026-10-21

The corpus becomes configurable: Reverie is no longer a session scraper.

### Added

- Corpus source interface (`lib/sources/`) with three adapters: `folder`
  (markdown/txt trees split at headings), `json`/`jsonl` exports, and
  `dsh-sessions` (the previous behaviour, now one source among several).
- `reverie_sources` lists every configured source with its groups, document
  counts and per-source problems.
- `reverie_read` expands a full `<source>/<inner>` locator; legacy
  `sessionId#seq` locators still resolve through the session source.
- `reverie_config` accepts `sources` with per-entry validation; invalid entries
  are dropped with a reported reason instead of failing the whole list.
- Corpus-wide caps and cache keys now cover every source, and one broken source
  contributes a problem line without erasing the rest of the corpus.

### Changed

- Locators are source-prefixed everywhere: search hits, run evidence indexes and
  reports use `notes/dir/note.md#L12-L40`, `journal/entries#3` or
  `dsh/session-id#96`.
- `reverie_sessions` is renamed to `reverie_sources`.
- The session source keeps its semantics (`source.kind` filtering, current
  surface, no live sessions) but moves behind the adapter interface.
- A folder-only composition no longer needs `sessionQuery`; only live runs need
  `llm`.

## [0.1.1] - 2026-10-21

Corpus hygiene after the first live run.

### Fixed

- A persisted session with no corpus-worthy text (created and closed unused, or
  carrying only harness injections) no longer appears in `reverie_sessions` or
  inflates the status counts.

## [0.1.0] - 2026-10-20

First public release: Reverie as a read-only DSH plugin over local session history.

### Added

- Seven host-side agent tools: `reverie_status`, `reverie_sessions`,
  `reverie_search`, `reverie_read`, `reverie_run`, `reverie_report`,
  `reverie_config`, plus a system-prompt announcement.
- Corpus adapter over `ctx.sessionQuery` that keeps persisted, non-live sessions
  only, scopes to the current workspace by default, caps sessions and documents,
  and reports per-session read failures instead of dropping the corpus. Inside a
  session only human-authored user text and assistant text enter the corpus:
  harness injections are excluded by `source.kind`, and reasoning or tool traffic
  never becomes corpus text.
- Host-free BM25 retrieval with latin words and CJK characters/bi-grams, a
  literal-phrase bonus, and `<sessionId>#<seq>` evidence locators.
- Reverie's own model loop over `ctx.llm`: streamed steps, block assembly,
  inner `reverie_search` / `reverie_read` / `reverie_note` tools, step, token and
  wall-clock budgets, `budget` / `max-steps` / `aborted` / `timeout` stop reasons.
- Deterministic `mock` mode that exercises corpus, ranking and artifact writing
  without any model call, seeded from tokens the newest document shares with
  other documents so its locators point somewhere other than the seed.
- Run artifacts under `$DSH_HOME/reverie/runs/<date>/<run-id>/` (`run.json`,
  `report.md`, `handoff.md`, `events.jsonl`, `usage.json`) plus `latest.json`,
  and a validated reader that refuses run ids or files outside its allowlist.
- Atomic runtime settings file `$DSH_HOME/reverie/config.json` with per-field
  validation; a corrupt file degrades to defaults and says so.
- Bilingual README (EN/ZH) and a 46-test suite covering config, corpus, search,
  loop, mock, and all tools end-to-end.

### Notes

- `live` runs spend the host provider's budget; `mock` is the default.
- The plugin never writes back to a session, memory store or corpus file.
