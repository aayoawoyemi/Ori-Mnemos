/**
 * BM25 from the persisted postings must equal BM25 from the vault.
 *
 * `buildBM25IndexFromVault` re-read and re-tokenized every note on every
 * query. Measured on the real 1,538-note vault 2026-09-15: 2,590 ms, 77% of a
 * 3,344 ms query, and issue #34's own diagnosis of why three of four signals
 * were silently skipped under a 400 ms budget.
 *
 * The replacement is only worth anything if it ranks identically, so that is
 * what these tests assert. On the real vault: 317,824 postings compared, 0 tf
 * mismatches, 0 document-length mismatches, avgDocLength equal to 9 decimal
 * places, and identical result lists for every probe query. Scoped builds
 * measured 0.37-10.8 ms against a 2,172 ms rebuild, so 201x at the worst
 * observed query and ~2,000x at the best.
 *
 * Two design points these tests exist to defend:
 *
 * 1. `note_term` stores per-FIELD counts, never a pre-weighted total. BM25
 *    weights title and description by config, so a stored weighted count would
 *    become silently wrong the moment a user edited `title_boost` - an index
 *    answering a question nobody asked. The boost-change test below is the
 *    assertion that keeps this honest.
 * 2. The scoped build returns only the query's terms. That is exact rather than
 *    approximate because `searchBM25` reads postings only for the query's own
 *    tokens; idf still sees each term's full posting count, and N and
 *    avgDocLength come from a corpus aggregate over `note`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  buildBM25IndexFromVault,
  buildBM25IndexFromStore,
  searchBM25,
} from "../../src/core/bm25.js";
import { initIndexStore, syncIndex } from "../../src/core/indexstore.js";
import { DEFAULT_BM25_CONFIG as DEFAULT_BM25 } from "../../src/core/config.js";
import type { ScoredNote } from "../../src/core/ranking.js";

let vault: string;
let db: InstanceType<typeof Database>;

const NOTES: Array<[string, string, string]> = [
  ["agent-memory", "how agents recall context", "agents remember across sessions and recall context"],
  ["resume-j", "Resume J the document", "Resume J is a named artifact with a single letter token"],
  ["carbonara", "pasta recipe", "eggs guanciale pecorino pasta"],
  ["graph-metrics", "pagerank and louvain", "pagerank louvain betweenness community detection on the graph"],
  ["empty-body", "a description only", ""],
];

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "ori-bm25store-"));
  await fs.mkdir(path.join(vault, "notes"), { recursive: true });
  await fs.mkdir(path.join(vault, ".ori"), { recursive: true });
  for (const [name, description, body] of NOTES) {
    await fs.writeFile(
      path.join(vault, "notes", `${name}.md`),
      `---\ndescription: ${description}\ntype: insight\nstatus: active\ncreated: 2024-01-01\n---\n\n${body}\n`,
      "utf8",
    );
  }
  db = new Database(path.join(vault, ".ori", "embeddings.db"));
  initIndexStore(db);
  await syncIndex(db, path.join(vault, "notes"));
});

afterEach(async () => {
  db.close();
  await fs.rm(vault, { recursive: true, force: true });
});

const QUERIES = [
  "agents recall context",
  "Resume J",
  "pasta",
  "pagerank louvain",
  "a",                 // tokenizes to nothing: single lower-case letter
  "zzzznotaword",      // no postings at all
];

function fingerprintOf(results: ScoredNote[]): string {
  return results.map((r) => `${r.title}:${r.score.toFixed(12)}`).join("|");
}

describe("store-backed BM25 (fix-list item 13)", () => {
  it("returns identical rankings and scores to the vault build", async () => {
    const vaultIndex = await buildBM25IndexFromVault(vault, DEFAULT_BM25);
    for (const query of QUERIES) {
      const scoped = buildBM25IndexFromStore(db, DEFAULT_BM25, query);
      expect(scoped, `no index for "${query}"`).toBeDefined();
      expect(
        fingerprintOf(searchBM25(query, scoped!, DEFAULT_BM25, 10)),
        `"${query}" must score identically from the store`,
      ).toBe(fingerprintOf(searchBM25(query, vaultIndex, DEFAULT_BM25, 10)));
    }
  });

  it("reproduces the corpus statistics exactly", async () => {
    const vaultIndex = await buildBM25IndexFromVault(vault, DEFAULT_BM25);
    const scoped = buildBM25IndexFromStore(db, DEFAULT_BM25, "agents")!;
    // idf reads N, and tf normalisation divides by avgDocLength, so either one
    // being off by a note silently shifts every score in the corpus.
    expect(scoped.docCount).toBe(vaultIndex.docCount);
    expect(scoped.avgDocLength).toBeCloseTo(vaultIndex.avgDocLength, 9);
  });

  it("counts a note with an empty body in the corpus statistics", async () => {
    // `buildBM25Index` calls docLengths.set for every document including one
    // whose weighted bag is empty, so docCount includes it. Sourcing the count
    // from `note_term` instead would quietly drop it and shift idf for every
    // query on any vault containing an empty note.
    const vaultIndex = await buildBM25IndexFromVault(vault, DEFAULT_BM25);
    const scoped = buildBM25IndexFromStore(db, DEFAULT_BM25, "agents")!;
    expect(vaultIndex.docCount).toBe(NOTES.length);
    expect(scoped.docCount).toBe(NOTES.length);
  });

  it("builds the whole inverted index when no query is given", async () => {
    const vaultIndex = await buildBM25IndexFromVault(vault, DEFAULT_BM25);
    const full = buildBM25IndexFromStore(db, DEFAULT_BM25)!;
    expect(full.termFreqs.size).toBe(vaultIndex.termFreqs.size);
    let mismatches = 0;
    for (const [term, docs] of vaultIndex.termFreqs) {
      const mine = full.termFreqs.get(term);
      if (!mine) { mismatches++; continue; }
      for (const [doc, tf] of docs) if (mine.get(doc) !== tf) mismatches++;
    }
    for (const [doc, len] of vaultIndex.docLengths) {
      if (full.docLengths.get(doc) !== len) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it("tracks a config change with no reindex", async () => {
    // The point of storing per-field counts. Raising title_boost must change
    // scores immediately, because the weighting is applied at query time
    // against the caller's live config rather than frozen into the index.
    const boosted = { ...DEFAULT_BM25, title_boost: DEFAULT_BM25.title_boost * 4 };
    const fromStore = buildBM25IndexFromStore(db, boosted, "agent memory")!;
    const fromVault = await buildBM25IndexFromVault(vault, boosted);
    expect(fingerprintOf(searchBM25("agent memory", fromStore, boosted, 10)))
      .toBe(fingerprintOf(searchBM25("agent memory", fromVault, boosted, 10)));
    // And it must actually differ from the default weighting, or this test
    // would pass against an index that ignored config entirely.
    const baseline = buildBM25IndexFromStore(db, DEFAULT_BM25, "agent memory")!;
    expect(fingerprintOf(searchBM25("agent memory", fromStore, boosted, 10)))
      .not.toBe(fingerprintOf(searchBM25("agent memory", baseline, DEFAULT_BM25, 10)));
  });

  it("returns undefined rather than an empty index when the store cannot answer", () => {
    const bare = new Database(":memory:");
    try {
      // No tables at all. The caller must be able to tell "cannot answer" from
      // "answered, nothing matched" - the first falls back to the vault and
      // warns, the second is a legitimate empty result.
      expect(buildBM25IndexFromStore(bare, DEFAULT_BM25, "anything")).toBeUndefined();
    } finally {
      bare.close();
    }
  });

  it("recovers an index that predates the per-field columns", async () => {
    // The upgrade path for every existing vault, and the only test that was
    // not starting from a fresh database. An ALTER alone is not enough: the
    // pre-existing note_term rows would sit at DEFAULT 0, and `syncIndex` is
    // stat-filtered, so an unchanged note is never reparsed and its counts
    // would stay zero forever - a keyword index that returns nothing and
    // blames the query. The migration drops the derived rows so the next sync
    // rebuilds them, which is the disposability the design promises being
    // cashed in. A mutation removing that drop leaves this test red.
    const old = path.join(vault, ".ori", "legacy.db");
    const legacy = new Database(old);
    try {
      // The v0.6.1 shape: postings with no term frequencies, notes with no
      // token totals.
      legacy.exec(`
        CREATE TABLE note (
          id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
          description TEXT, type TEXT, status TEXT, created TEXT,
          content_hash TEXT NOT NULL, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL,
          indexed_at TEXT NOT NULL
        );
        CREATE TABLE note_term (
          note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
          term TEXT NOT NULL, PRIMARY KEY (note_id, term)
        ) WITHOUT ROWID;
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      // The row must look UP TO DATE, or the hazard is not reproduced: with a
      // stale mtime the stat filter reparses the note and repairs the counts
      // by accident. The dangerous case is an old index that is perfectly
      // current, so the filter skips every note and nothing ever refills the
      // new columns. A first version of this test used mtime 1 and a fake
      // hash, and stayed green against a migration that dropped nothing.
      const file = path.join(vault, "notes", "agent-memory.md");
      const stat = await fs.stat(file);
      const content = await fs.readFile(file, "utf8");
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
      legacy.prepare(
        "INSERT INTO note (slug, title, content_hash, mtime_ms, size_bytes, indexed_at) " +
        "VALUES ('agent-memory', 'agent-memory', ?, ?, ?, '2026-01-01T00:00:00Z')",
      ).run(hash, stat.mtimeMs, stat.size);
      legacy.prepare("INSERT INTO note_term (note_id, term) VALUES (1, 'agents')").run();

      initIndexStore(legacy);
      await syncIndex(legacy, path.join(vault, "notes"));

      const scoped = buildBM25IndexFromStore(legacy, DEFAULT_BM25, "agents recall context");
      expect(scoped, "an upgraded index must still answer").toBeDefined();
      const vaultIndex = await buildBM25IndexFromVault(vault, DEFAULT_BM25);
      expect(fingerprintOf(searchBM25("agents recall context", scoped!, DEFAULT_BM25, 10)))
        .toBe(fingerprintOf(searchBM25("agents recall context", vaultIndex, DEFAULT_BM25, 10)));
    } finally {
      legacy.close();
    }
  });

  it("reflects an edited note after a sync", async () => {
    await fs.writeFile(
      path.join(vault, "notes", "carbonara.md"),
      "---\ndescription: pasta recipe\ntype: insight\nstatus: active\ncreated: 2024-01-01\n---\n\n" +
      "now mentions pagerank louvain betweenness\n",
      "utf8",
    );
    await syncIndex(db, path.join(vault, "notes"));
    const scoped = buildBM25IndexFromStore(db, DEFAULT_BM25, "pagerank")!;
    expect(scoped.termFreqs.get("pagerank")?.has("carbonara")).toBe(true);
    const vaultIndex = await buildBM25IndexFromVault(vault, DEFAULT_BM25);
    expect(fingerprintOf(searchBM25("pagerank", scoped, DEFAULT_BM25, 10)))
      .toBe(fingerprintOf(searchBM25("pagerank", vaultIndex, DEFAULT_BM25, 10)));
  });
});
