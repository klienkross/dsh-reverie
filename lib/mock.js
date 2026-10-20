/**
 * Deterministic mock trip.
 *
 * `mock` exists so the whole pipeline — corpus read, lexical ranking, artifact
 * writing, report shape — can be exercised and shipped without an API key.
 * It must be honest about what it is: the note says no model was called, and
 * the report keeps the same "model-generated, unverified" framing as a live
 * trip. Nothing here invents evidence: every locator comes from the corpus.
 *
 * @module dsh-reverie/mock
 */

import { searchIndex, tokenize } from "./search.js";
import { isoTime, oneLine, truncate } from "./text.js";

/**
 * Pick a few tokens the seed document shares with at least one other document.
 *
 * Tokens unique to the seed would only find the seed itself, so the heuristic
 * keeps mid-frequency tokens: rare enough to be specific, shared enough to
 * point somewhere else. This is what makes a mock trip's locators land on
 * documents other than the one it started from.
 * @param {any} index - corpus index.
 * @param {number} position - seed document position.
 * @param {number} count - how many tokens to keep.
 * @returns {string[]} shared, CJK-aware tokens.
 */
export function sharedTokens(index, position, count = 4) {
  const entry = index.postings.get(String(position));
  if (!entry) return [];
  const ceiling = Math.max(2, Math.floor(index.size / 2));
  const ranked = [...entry.tf.keys()]
    .filter((token) => token.length >= 2)
    .map((token) => ({ token, df: index.df.get(token) ?? 0 }))
    .filter((candidate) => candidate.df >= 2 && candidate.df <= ceiling)
    .sort((left, right) => left.df - right.df || left.token.localeCompare(right.token));
  return ranked.slice(0, count).map((candidate) => candidate.token);
}

/**
 * Run one deterministic mock trip over an already-built corpus.
 * @param {{index: any, documents: any[], language: "zh" | "en", maxNoteChars: number}} options - corpus and limits.
 * @returns {{note: string, events: any[], stopReason: string, usage: {input: number, output: number, total: number, steps: number}, seeds: any[]}}
 *   the mock trip, shaped like a real run.
 */
export function runMock(options) {
  const { index, documents } = options;
  const startedAt = Date.now();
  /** @type {any[]} */
  const seeds = [];
  // Deterministic seed choice: the newest document with enough text to be worth
  // following. Very short chat turns are poor seeds, so they are skipped.
  let seedPosition = -1;
  for (let position = documents.length - 1; position >= 0; position -= 1) {
    if (documents[position].text.length >= 60) {
      seedPosition = position;
      break;
    }
  }
  const events = [
    {
      step: 0,
      kind: "mock",
      at: startedAt,
      note: "no model call; corpus and ranking exercise only",
    },
  ];
  if (seedPosition === -1) {
    const note =
      options.language === "en"
        ? "_Mock run — the corpus holds no document long enough to seed a trip. Index more history or widen the scope._"
        : "_Mock 运行 —— 语料里没有足够长的消息可以作为起点。扩大范围或换一个语料来源后再试。_";
    events.push({ step: 0, kind: "settlement", at: Date.now(), stopReason: "empty-corpus", noteCalls: 0 });
    return { note, events, stopReason: "empty-corpus", usage: { input: 0, output: 0, total: 0, steps: 0 }, seeds };
  }

  const seed = documents[seedPosition];
  const tokens = sharedTokens(index, seedPosition, 4);
  const query = tokens.join(" ");
  const { hits } = searchIndex(index, query, { limit: 4 });
  for (const hit of hits.slice(1)) {
    const document = documents[hit.position];
    seeds.push({
      sessionId: document.sessionId,
      seq: document.seq,
      time: document.time,
      snippet: hit.snippet,
      score: Number(hit.score.toFixed(3)),
      tokens: hit.matched,
    });
  }
  events.push({
    step: 1,
    kind: "tool",
    at: Date.now(),
    name: "reverie_search",
    arguments: JSON.stringify({ query }),
    isError: false,
    result: JSON.stringify({ hits: seeds.length }),
  });

  const evidence = seeds
    .slice(0, 3)
    .map((seed) => `- \`${seed.sessionId}#${seed.seq}\` ${isoTime(seed.time)} — ${oneLine(seed.snippet, 140)}`)
    .join("\n");
  const body =
    options.language === "en"
      ? [
          "**Topic**",
          `${oneLine(seed.text, 90)}`,
          "",
          "**What a lexical pass noticed**",
          tokens.length === 0
            ? "No distinctive tokens were found; the corpus around the seed is too uniform for this heuristic."
            : `The seed shares low-frequency tokens (${tokens.join(", ")}) with the messages below. That is a co-occurrence signal, not a finding.`,
          "",
          "**Evidence**",
          evidence === "" ? "- (none)" : evidence,
          "",
          "**Unresolved**",
          "A mock trip does not read the originals or reason about them. Treat everything above as a pointer into the corpus, not a conclusion.",
        ].join("\n")
      : [
          "**主题**",
          `${oneLine(seed.text, 90)}`,
          "",
          "**词法扫描看到的东西**",
          tokens.length === 0
            ? "没有找到有区分度的词元；起点附近的语料过于均质，这个启发式没有产出。"
            : `起点与下列消息共享低频词元（${tokens.join("、")}）。这只是共现信号，不是发现。`,
          "",
          "**证据**",
          evidence === "" ? "- （无）" : evidence,
          "",
          "**未解决**",
          "mock 运行不会展开原文、也不会推理。上面的内容只是指向语料的路标，不是结论。",
        ].join("\n");
  const note = truncate(body, options.maxNoteChars);
  events.push({ step: 1, kind: "mock-note", at: Date.now(), blockChars: note.length });
  events.push({
    step: 1,
    kind: "settlement",
    at: Date.now(),
    stopReason: "mock-ended",
    noteCalls: 1,
    usage: { input: 0, output: 0, total: 0 },
  });
  return {
    note,
    events,
    stopReason: "mock-ended",
    usage: { input: 0, output: 0, total: 0, steps: 1 },
    seeds,
  };
}

/**
 * Describe one token list for diagnostics without dumping the corpus.
 * @param {string} text - source text.
 * @param {number} count - token count to keep.
 * @returns {string} the head of the token list.
 */
export function tokenPreview(text, count = 8) {
  return tokenize(text).slice(0, count).join(" ");
}
