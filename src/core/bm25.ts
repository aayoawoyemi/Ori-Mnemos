import type Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScoredNote } from "./ranking.js";
import type { BM25Config } from "./config.js";
import { DEFAULT_BM25_CONFIG as DEFAULT_BM25 } from "./config.js";
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
  // Single-character tokens are kept only when they look like an identifier:
  // a digit, or an upper-case letter that is NOT the first token ("Resume J",
  // "Plan B", "Type A"). A sentence-initial capital ("I am...") is a pronoun,
  // not a label, and stays dropped along with all lower-case singletons.
  // Before 2026-09-06 every 1-char token was discarded, which made "Resume J"
  // tokenize to ["resume"] and the document name unmatchable lexically.
  const out: string[] = [];
  let first = true;
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const t = raw.toLowerCase();
    const isFirst = first;
    first = false;
    if (STOPWORDS.has(t)) continue;
    if (t.length >= 2) { out.push(t); continue; }
    if (/^[0-9]$/.test(raw) || (/^[A-Z]$/.test(raw) && !isFirst)) out.push(t);
  }
  return out;
}

// ── Default config ───────────────────────────────────────────────────


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
/**
 * Build the same inverted index from the persisted postings.
 *
 * `buildBM25IndexFromVault` re-reads and re-tokenizes every note on every
 * query. Measured on the real 1,538-note vault 2026-09-15: 2,590 ms, which was
 * 77% of a 3,344 ms query - the largest single cost in the pipeline and issue
 * #34's own diagnosis. Reading `note_term` instead is a single indexed scan.
 *
 * `note_term` stores per-FIELD counts, so the boost weighting is applied here,
 * at query time, against the caller's live config. That is what makes this
 * index config-independent: change `title_boost` and the next query is correct
 * with no reindex. Storing a pre-weighted count would have frozen one config
 * into the derived data.
 *
 * Returns undefined when the store cannot answer - no tables, or an index that
 * predates the per-field columns. The caller falls back to the vault and says
 * so; a stale index must never quietly answer a different question.
 */
export function buildBM25IndexFromStore(
  db: InstanceType<typeof Database>,
  config: BM25Config = DEFAULT_BM25,
  query?: string,
): BM25Index | undefined {
  const weighted =
    `(t.tf_title * ${config.title_boost} + t.tf_desc * ${config.description_boost} + t.tf_body)`;

  // Corpus-wide statistics from `note`, one row per note, computed in SQL so
  // no JS object is allocated per posting. Reading these off `note_term`
  // instead scanned 317,824 rows on every query and cost 40-116 ms of pure
  // aggregation - which is why the first scoped version still was not fast.
  //
  // `docCount` counts ALL notes, and the average divides by all of them,
  // exactly matching `buildBM25Index`: it calls docLengths.set for every doc
  // including one whose weighted bag is empty. Counting only notes that have
  // postings would shift idf on any vault containing an empty note.
  let stats: { docs: number; total: number } | undefined;
  try {
    stats = db
      .prepare(
        `SELECT COUNT(*) AS docs,
                SUM(tok_title * ${config.title_boost}
                  + tok_desc * ${config.description_boost}
                  + tok_body) AS total
           FROM note`,
      )
      .get() as { docs: number; total: number } | undefined;
  } catch {
    return undefined;
  }
  if (!stats || stats.docs === 0 || !stats.total) return undefined;
  const avgDocLength = stats.total / stats.docs;

  // Scope to the query's terms when there is one. `searchBM25` reads postings
  // only for the query's own tokens and document lengths only for the notes
  // those postings name, so a scoped index produces bit-identical scores:
  // idf needs n = the term's full posting count, which is still complete here,
  // and N + avgDocLength come from the corpus aggregate above.
  //
  // This is the difference between 2,590 ms and single-digit milliseconds. The
  // first version of this function faithfully rebuilt all 22,632 terms from
  // SQL and only reached 1,254 ms: the cost was never reading the vault, it
  // was materialising a corpus-sized inverted index to answer a three-word
  // query. Fixing the storage without fixing the scope would have banked a
  // 1.6x win and declared the item closed.
  const terms = query === undefined ? undefined : [...new Set(tokenize(query))];
  if (terms !== undefined && terms.length === 0) {
    return { termFreqs: new Map(), docLengths: new Map(), avgDocLength, docCount: stats.docs };
  }

  const termFreqs = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();
  try {
    const postings = terms === undefined
      ? db
        .prepare(
          `SELECT n.slug AS slug, t.term AS term, ${weighted} AS count
             FROM note_term t JOIN note n ON n.id = t.note_id`,
        )
        .all()
      : db
        .prepare(
          `SELECT n.slug AS slug, t.term AS term, ${weighted} AS count
             FROM note_term t JOIN note n ON n.id = t.note_id
            WHERE t.term IN (${terms.map(() => "?").join(",")})`,
        )
        .all(...terms);

    const matched = new Set<string>();
    for (const row of postings as Array<{ slug: string; term: string; count: number }>) {
      if (row.count <= 0) continue;
      let docMap = termFreqs.get(row.term);
      if (!docMap) {
        docMap = new Map<string, number>();
        termFreqs.set(row.term, docMap);
      }
      docMap.set(row.slug, row.count);
      matched.add(row.slug);
    }
    if (matched.size === 0) {
      return { termFreqs, docLengths, avgDocLength, docCount: stats.docs };
    }

    // Document lengths for the matched notes, straight off the note row.
    // A note's length is the sum over ALL its terms, not just the query's, so
    // this cannot be folded into the postings query - but it no longer needs a
    // GROUP BY over postings either.
    const slugs = [...matched];
    const lengths = db
      .prepare(
        `SELECT slug,
                (tok_title * ${config.title_boost}
               + tok_desc * ${config.description_boost}
               + tok_body) AS len
           FROM note
          WHERE slug IN (${slugs.map(() => "?").join(",")})`,
      )
      .all(...slugs) as Array<{ slug: string; len: number }>;
    for (const row of lengths) docLengths.set(row.slug, row.len);
  } catch {
    return undefined;
  }

  return { termFreqs, docLengths, avgDocLength, docCount: stats.docs };
}

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
