/**
 * Provider-independent lexical ranking for the Reverie corpus.
 *
 * The corpus is personal writing in whatever language the operator happens to
 * use, so the tokenizer must handle scripts without spaces. It emits
 * lowercased latin words plus CJK characters and bi-grams; BM25 (k1 = 1.2,
 * b = 0.75) ranks documents, and a literal phrase hit adds a bounded bonus.
 * Everything is deterministic: the same corpus and query always rank the same.
 *
 * @module dsh-reverie/search
 */

const K1 = 1.2;
const B = 0.75;
/** A literal phrase hit is worth this many idf-weighted units. */
const PHRASE_BONUS = 4;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const WORD = /[0-9a-z_]+/;

/**
 * Tokenize text for indexing and querying.
 * @param {string} text - raw text.
 * @returns {string[]} lowercase latin words plus CJK characters and bi-grams.
 */
export function tokenize(text) {
  const value = String(text ?? "").toLowerCase();
  /** @type {string[]} */
  const tokens = [];
  let run = "";
  const flush = () => {
    if (run !== "") {
      // CJK: one token per character and one per adjacent pair, so short
      // queries still match and multi-character terms stay specific.
      for (let i = 0; i < run.length; i += 1) tokens.push(run[i]);
      for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
      run = "";
    }
  };
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (CJK.test(char)) {
      run += char;
      index += 1;
      continue;
    }
    flush();
    const rest = value.slice(index);
    const match = WORD.exec(rest);
    if (match && match.index === 0) {
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    index += 1;
  }
  flush();
  return tokens;
}

/**
 * Build a searchable index over one corpus snapshot.
 * @param {{sessionId: string, seq: number, time: number, role: string, text: string}[]} documents - corpus documents.
 * @returns {{documents: any[], postings: Map<string, {tf: Map<number, number>, length: number}>, df: Map<string, number>, avgLength: number, size: number}}
 *   the immutable index.
 */
export function buildIndex(documents) {
  /** @type {Map<string, {tf: Map<number, number>, length: number}>} */
  const postings = new Map();
  const df = new Map();
  let totalLength = 0;
  documents.forEach((document, position) => {
    const tokens = tokenize(document.text);
    totalLength += tokens.length;
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    postings.set(String(position), { tf, length: tokens.length });
  });
  const size = documents.length;
  return { documents, postings, df, avgLength: size === 0 ? 0 : totalLength / size, size };
}

/**
 * Escape a literal for a case-insensitive regular expression.
 * @param {string} value - literal text.
 * @returns {RegExp} a whitespace-flexible matcher.
 */
export function literalPattern(value) {
  const parts = value
    .normalize("NFKC")
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return /$^/;
  return new RegExp(parts.join("\\s*"), "iu");
}

/**
 * Extract a readable excerpt around the first query hit.
 * @param {string} text - document text.
 * @param {string[]} tokens - query tokens, most specific first.
 * @param {number} radius - characters kept on each side.
 * @returns {string} the excerpt.
 */
export function snippet(text, tokens, radius = 90) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= radius * 2) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    if (token.length === 0) continue;
    const found = lower.indexOf(token);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return `${flat.slice(0, radius * 2)}…`;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Rank documents against one query.
 * @param {ReturnType<typeof buildIndex>} index - corpus index.
 * @param {string} query - caller text; interpreted as data, never as syntax.
 * @param {{limit?: number, offset?: number}} [options] - page window.
 * @returns {{hits: {position: number, score: number, snippet: string, matched: string[]}[], tokens: string[], total: number}}
 *   ranked hits and query tokens; `total` counts positive-scoring documents.
 */
export function searchIndex(index, query, options = {}) {
  const limit = Math.max(1, Math.min(50, options.limit ?? 8));
  const offset = Math.max(0, options.offset ?? 0);
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0 || index.size === 0) return { hits: [], tokens, total: 0 };
  // Rarer tokens discriminate better; keep them first for snippet selection.
  const ordered = tokens.slice().sort((left, right) => (index.df.get(left) ?? 0) - (index.df.get(right) ?? 0));
  const phrase = literalPattern(query);
  const scores = [];
  index.documents.forEach((document, position) => {
    const entry = index.postings.get(String(position));
    if (!entry) return;
    let score = 0;
    const matched = [];
    for (const token of tokens) {
      const tf = entry.tf.get(token);
      if (!tf) continue;
      matched.push(token);
      const df = index.df.get(token) ?? 0;
      const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
      const denominator = tf + K1 * (1 - B + B * (entry.length / (index.avgLength || 1)));
      score += idf * ((tf * (K1 + 1)) / denominator);
    }
    if (score === 0) return;
    if (phrase.test(document.text)) score += PHRASE_BONUS;
    scores.push({ position, score, matched });
  });
  scores.sort((left, right) => right.score - left.score || right.position - left.position);
  const hits = scores.slice(offset, offset + limit).map((entry) => ({
    ...entry,
    snippet: snippet(index.documents[entry.position].text, ordered),
  }));
  return { hits, tokens: ordered, total: scores.length };
}

/**
 * Describe which query tokens a hit actually contained.
 * @param {string[]} matched - tokens found in the document.
 * @returns {string} a comma-separated description.
 */
export function describeMatch(matched) {
  return [...new Set(matched)].slice(0, 6).join(", ");
}
