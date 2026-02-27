import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScoredNote } from "./ranking.js";
import type { BM25Config } from "./config.js";
import { parseFrontmatter } from "./frontmatter.js";

// ── Stopwords ────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "he", "in", "is", "it", "its", "of", "on", "or", "that",
  "the", "to", "was", "were", "will", "with",
]);

// ── Types ────────────────────────────────────────────────────────────
export interface BM25Index {
  termFreqs: Map<string, Map<string, number>>; // term → { docTitle → count }
  docLengths: Map<string, number>;              // docTitle → total word count
  avgDocLength: number;
  docCount: number;
}

// ── Tokenizer ────────────────────────────────────────────────────────
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ── Default config ───────────────────────────────────────────────────
const DEFAULT_BM25: BM25Config = {
  k1: 1.2,
  b: 0.75,
  title_boost: 3.0,
  description_boost: 2.0,
};

// ── Build index ──────────────────────────────────────────────────────
export function buildBM25Index(
  docs: Array<{ title: string; description: string; body: string }>,
  config: BM25Config = DEFAULT_BM25,
): BM25Index {
  const termFreqs = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();

  for (const doc of docs) {
    const titleTokens = tokenize(doc.title);
    const descTokens = tokenize(doc.description);
    const bodyTokens = tokenize(doc.body);

    // Weighted token bag: title tokens counted title_boost times, etc.
    const bag = new Map<string, number>();

    for (const t of titleTokens) {
      bag.set(t, (bag.get(t) ?? 0) + config.title_boost);
    }
    for (const t of descTokens) {
      bag.set(t, (bag.get(t) ?? 0) + config.description_boost);
    }
    for (const t of bodyTokens) {
      bag.set(t, (bag.get(t) ?? 0) + 1);
    }

    // Document length = weighted token count
    let docLen = 0;
    for (const count of bag.values()) {
      docLen += count;
    }
    docLengths.set(doc.title, docLen);

    // Populate inverted index
    for (const [term, count] of bag) {
      let docMap = termFreqs.get(term);
      if (!docMap) {
        docMap = new Map<string, number>();
        termFreqs.set(term, docMap);
      }
      docMap.set(doc.title, count);
    }
  }

  const totalLength = Array.from(docLengths.values()).reduce((a, b) => a + b, 0);
  const avgDocLength = docs.length > 0 ? totalLength / docs.length : 0;

  return {
    termFreqs,
    docLengths,
    avgDocLength,
    docCount: docs.length,
  };
}

// ── BM25 search ──────────────────────────────────────────────────────
export function searchBM25(
  query: string,
  index: BM25Index,
  config: BM25Config = DEFAULT_BM25,
  limit: number = 10,
): ScoredNote[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const { termFreqs, docLengths, avgDocLength, docCount } = index;
  const { k1, b } = config;
  const N = docCount;

  // Collect scores per document
  const scores = new Map<string, number>();

  for (const term of queryTokens) {
    const docMap = termFreqs.get(term);
    if (!docMap) continue;

    const n = docMap.size; // docs containing term
    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);

    for (const [docTitle, tf] of docMap) {
      const dl = docLengths.get(docTitle) ?? 0;
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDocLength)));
      const termScore = idf * tfNorm;
      scores.set(docTitle, (scores.get(docTitle) ?? 0) + termScore);
    }
  }

  // Build ScoredNote array, sort, limit
  const results: ScoredNote[] = [];
  for (const [title, score] of scores) {
    results.push({
      title,
      score,
      signals: { keyword: score },
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ── Build index from vault ───────────────────────────────────────────
export async function buildBM25IndexFromVault(
  vaultRoot: string,
  config: BM25Config = DEFAULT_BM25,
): Promise<BM25Index> {
  const notesDir = path.join(vaultRoot, "notes");
  const entries = await fs.readdir(notesDir);
  const mdFiles = entries.filter((e) => e.endsWith(".md"));

  const docs: Array<{ title: string; description: string; body: string }> = [];

  for (const file of mdFiles) {
    const filePath = path.join(notesDir, file);
    const content = await fs.readFile(filePath, "utf-8");
    const { data, body } = parseFrontmatter(content);
    const title = file.replace(/\.md$/, "");
    const description = (data && typeof data.description === "string") ? data.description : "";

    docs.push({ title, description, body });
  }

  return buildBM25Index(docs, config);
}
