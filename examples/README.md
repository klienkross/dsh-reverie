# Tiny memory library (fictional demo corpus)

This directory is a **fictional** archive, written for this repository only. It exists so you can see what Reverie produces before pointing it at anything personal.

Six notes, four "layers" of one person's life, deliberately written so the same motifs recur across unrelated files:

```
日记/2026-03-02.md         night shift, fog, a borrowed book
日记/2026-03-05.md         insomnia, a short-story idea
读书/海边的房间-摘录.md      a reading excerpt with a "to check" note
梦境/雾中的第四层.md         a dream on the same corridor
项目/夜航计划.md            a small archive project
笔记/索引整理.md            a meta note about organizing
```

## See the output without running anything

[`../docs/sample-report.md`](../docs/sample-report.md) is a mock run over this corpus: no model call, no API cost. It shows the report shape, the evidence index, and the private note.

## Run it yourself

```jsonc
// reverie_config → set
{
  "sources": [
    { "id": "demo", "kind": "folder", "root": "<this repo>/examples/tiny-memory-library" }
  ]
}
```

Then call `reverie_run` with `live: false`. To regenerate the committed sample report:

```sh
node examples/build-sample-report.mjs
```

## Point it at your own archive instead

Same config, different `root`:

```jsonc
{ "sources": [{ "id": "notes", "kind": "folder", "root": "D:/notes", "extensions": ["md"] }] }
```

Reverie only reads. Artifacts land under `~/.dsh/reverie/runs/`; nothing is written back to your notes.
