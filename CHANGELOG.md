# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-20

First public release: Reverie as a read-only DSH plugin over local session history.

### Added

- Seven host-side agent tools: `reverie_status`, `reverie_sessions`,
  `reverie_search`, `reverie_read`, `reverie_run`, `reverie_report`,
  `reverie_config`, plus a system-prompt announcement.
- Corpus adapter over `ctx.sessionQuery` that keeps persisted, non-live sessions
  only, scopes to the current workspace by default, caps sessions and documents,
  and reports per-session read failures instead of dropping the corpus.
- Host-free BM25 retrieval with latin words and CJK characters/bi-grams, a
  literal-phrase bonus, and `<sessionId>#<seq>` evidence locators.
- Reverie's own model loop over `ctx.llm`: streamed steps, block assembly,
  inner `reverie_search` / `reverie_read` / `reverie_note` tools, step, token and
  wall-clock budgets, `budget` / `max-steps` / `aborted` / `timeout` stop reasons.
- Deterministic `mock` mode that exercises corpus, ranking and artifact writing
  without any model call.
- Run artifacts under `$DSH_HOME/reverie/runs/<date>/<run-id>/` (`run.json`,
  `report.md`, `handoff.md`, `events.jsonl`, `usage.json`) plus `latest.json`,
  and a validated reader that refuses run ids or files outside its allowlist.
- Atomic runtime settings file `$DSH_HOME/reverie/config.json` with per-field
  validation; a corrupt file degrades to defaults and says so.
- Bilingual README (EN/ZH) and a 45-test suite covering config, corpus, search,
  loop, mock, and all tools end-to-end.

### Notes

- `live` runs spend the host provider's budget; `mock` is the default.
- The plugin never writes back to a session, memory store or corpus file.
