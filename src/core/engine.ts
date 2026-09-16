import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { pipeline as hfPipeline } from "@huggingface/transformers";

import type { EngineConfig } from "./config.js";
import type {
  ClassifiedQuery,
  SpaceWeights,
  SplitWeights,
} from "./intent.js";
import type { ScoredNote } from "./ranking.js";
import type { LinkGraph } from "./graph.js";
import { buildGraph } from "./graph.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { GraphMetrics } from "./importance.js";
import { computeGraphMetrics } from "./importance.js";

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface StoredVectors {
  titleVec: Float32Array;
  descVec: Float32Array;
  bodyVec: Float32Array;
  typeVec: Float32Array;
  communityVec: Float32Array;
  contentHash: string;
  indexedAt: string;
}

export interface IndexStats {
  indexed: number;
  skipped: number;
  total: number;
  durationMs: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export function initDB(dbPath: string): InstanceType<typeof Database> {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      title TEXT PRIMARY KEY,
      title_vec BLOB,
      desc_vec BLOB,
      body_vec BLOB,
      type_vec BLOB,
      community_vec BLOB,
      content_hash TEXT,
      indexed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS boosts (
      title TEXT PRIMARY KEY,
      boost REAL DEFAULT 0,
      updated TEXT,
      access_count INTEGER DEFAULT 1,
      sessions TEXT DEFAULT ''
    );
  `);

  // Migration: add Ebbinghaus columns to existing boosts tables
  try {
    db.exec(`ALTER TABLE boosts ADD COLUMN access_count INTEGER DEFAULT 1`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE boosts ADD COLUMN sessions TEXT DEFAULT ''`);
  } catch { /* column already exists */ }

  return db;
}

export function removeNoteFromDB(
  db: InstanceType<typeof Database>,
  title: string,
): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM embeddings WHERE title = ?").run(title);
    db.prepare("DELETE FROM boosts WHERE title = ?").run(title);
  });
  tx();
}

// ---------------------------------------------------------------------------
// Vector loading
// ---------------------------------------------------------------------------

/**
 * A space the caller does not weight is a space it does not need loaded.
 *
 * Weights are read exactly the way `searchComposite` reads them: a space
 * whose weight is `0` cannot contribute to any composite score, so its column
 * is left in SQLite and its slot is filled with an empty vector. `cosine`
 * already returns 0 for a zero-length vector, so a pruned space is
 * arithmetically identical to a loaded one multiplied by its zero weight -
 * pruning cannot move a ranking, by construction.
 *
 * A missing field means "needed". Only an explicit `0` prunes, so
 * `loadVectors(db)` still loads every column and every existing caller is
 * untouched.
 *
 * None of the four built-in intent profiles zeroes a space (the smallest
 * weight is 0.05), so passing `intent.spaceWeights` prunes nothing today.
 * The win is for callers that genuinely need a subset: the warmth scan reads
 * only `bodyVec`/`descVec`, and on the 1,527-row vault that subset loads in
 * 7.0 ms against 23.0 ms for all five columns.
 */
export interface LoadVectorsOptions {
  spaceWeights?: Partial<SpaceWeights>;
  splitWeights?: Partial<SplitWeights>;
}

const EMPTY_VECTOR = new Float32Array(0);

interface ColumnPlan {
  sql: string;
  titleVec: number;
  descVec: number;
  bodyVec: number;
  typeVec: number;
  communityVec: number;
  contentHash: number;
  indexedAt: number;
}

function planVectorColumns(options?: LoadVectorsOptions): ColumnPlan {
  const sw = options?.spaceWeights;
  const splitW = options?.splitWeights;
  const textWanted = (sw?.text ?? 1) !== 0;

  const columns: string[] = ["title"];
  const take = (wanted: boolean, column: string): number => {
    if (!wanted) return -1;
    columns.push(column);
    return columns.length - 1;
  };

  // Evaluated in source order, so each index matches its position in `columns`.
  const titleVec = take(textWanted && (splitW?.title ?? 1) !== 0, "title_vec");
  const descVec = take(
    textWanted && (splitW?.description ?? 1) !== 0,
    "desc_vec",
  );
  const bodyVec = take(textWanted && (splitW?.body ?? 1) !== 0, "body_vec");
  const typeVec = take((sw?.type ?? 1) !== 0, "type_vec");
  const communityVec = take((sw?.community ?? 1) !== 0, "community_vec");
  const contentHash = take(true, "content_hash");
  const indexedAt = take(true, "indexed_at");

  return {
    sql: `SELECT ${columns.join(", ")} FROM embeddings`,
    titleVec,
    descVec,
    bodyVec,
    typeVec,
    communityVec,
    contentHash,
    indexedAt,
  };
}

function vectorAt(row: unknown[], index: number): Float32Array {
  if (index < 0) return EMPTY_VECTOR;
  const blob = row[index];
  // A NULL blob used to throw out of loadVectors and abort the whole session.
  // The index is derived data; an unreadable space degrades to "no signal".
  return Buffer.isBuffer(blob) ? bufferToFloat32(blob) : EMPTY_VECTOR;
}

export function loadVectors(
  db: InstanceType<typeof Database>,
  options?: LoadVectorsOptions,
): Map<string, StoredVectors> {
  const plan = planVectorColumns(options);
  // `.raw()` yields positional rows: no 8-key object per note, and the column
  // set is dynamic anyway once pruning is in play.
  const rows = db.prepare(plan.sql).raw().all() as unknown[][];

  const map = new Map<string, StoredVectors>();
  for (const row of rows) {
    map.set(row[0] as string, {
      titleVec: vectorAt(row, plan.titleVec),
      descVec: vectorAt(row, plan.descVec),
      bodyVec: vectorAt(row, plan.bodyVec),
      typeVec: vectorAt(row, plan.typeVec),
      communityVec: vectorAt(row, plan.communityVec),
      contentHash: row[plan.contentHash] as string,
      indexedAt: row[plan.indexedAt] as string,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedPipeline: any = null;
let cachedModelName: string | null = null;

export async function embedText(
  text: string,
  config: EngineConfig,
): Promise<Float32Array> {
  if (!cachedPipeline || cachedModelName !== config.embedding_model) {
    // The hf/transformers pipeline() overloads produce a union too complex
    // for TS to resolve, so we cast through unknown.
    cachedPipeline = await (hfPipeline as any)(
      "feature-extraction",
      config.embedding_model,
      { dtype: "fp32" },
    );
    cachedModelName = config.embedding_model;
  }

  const result = await cachedPipeline(text, {
    pooling: "mean",
    normalize: true,
  });
  return new Float32Array(result.data);
}

// ---------------------------------------------------------------------------
// Knowledge enrichment
// ---------------------------------------------------------------------------

export function buildKnowledgeEnrichedText(
  title: string,
  frontmatter: Record<string, unknown>,
  _body: string,
  linkGraph: LinkGraph,
): string {
  const noteType =
    typeof frontmatter.type === "string" ? frontmatter.type : "";
  const projects = Array.isArray(frontmatter.project)
    ? (frontmatter.project as string[]).join(", ")
    : typeof frontmatter.project === "string"
      ? (frontmatter.project as string)
      : "";
  const description =
    typeof frontmatter.description === "string"
      ? (frontmatter.description as string)
      : "";

  // Collect connected note titles (outgoing links, up to 10)
  const outgoing = linkGraph.outgoing.get(title);
  const connected = outgoing
    ? Array.from(outgoing).slice(0, 10).join(", ")
    : "";

  const parts: string[] = [];

  // Line 1: [TYPE] [PROJECTS]
  if (noteType || projects) {
    const typePart = noteType ? `[${noteType.toUpperCase()}]` : "";
    const projPart = projects ? `[${projects}]` : "";
    parts.push([typePart, projPart].filter(Boolean).join(" "));
  }

  // Title
  parts.push(title);

  // Description
  if (description) parts.push(description);

  // Connected notes
  if (connected) parts.push(`Connected: ${connected}`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Encoding functions
// ---------------------------------------------------------------------------

export function encodePiecewiseLinear(
  value: number,
  bins: number,
): Float32Array {
  const vec = new Float32Array(bins);
  const v = Math.max(0, Math.min(1, value));

  // Each bin covers range [i/bins, (i+1)/bins]
  // Bins below the value's bin are fully activated (1.0)
  // The value's bin gets partial membership (fractional fill)
  // Bins above remain 0
  const scaled = v * bins;
  const binIndex = Math.min(Math.floor(scaled), bins - 1);
  const frac = scaled - binIndex;

  for (let i = 0; i < bins; i++) {
    if (i < binIndex) {
      vec[i] = 1.0;
    } else if (i === binIndex) {
      vec[i] = frac;
    }
    // else remains 0
  }

  // Special case: value = 1.0 -> last bin fully activated
  if (v >= 1.0) {
    for (let i = 0; i < bins; i++) {
      vec[i] = 1.0;
    }
  }

  return vec;
}

const TYPE_LABELS = [
  "idea",
  "decision",
  "learning",
  "insight",
  "blocker",
  "opportunity",
] as const;

export function encodeType(noteType: string): Float32Array {
  const vec = new Float32Array(6);
  const idx = TYPE_LABELS.indexOf(
    noteType as (typeof TYPE_LABELS)[number],
  );
  if (idx >= 0) {
    vec[idx] = 1.0;
  }
  return vec;
}

// Small primes for hash-based community projection
const PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53,
];

export function encodeCommunity(
  communityId: number,
  totalCommunities: number,
  dims: number,
): Float32Array {
  const vec = new Float32Array(dims);
  const tc = Math.max(totalCommunities, 1);
  for (let d = 0; d < dims; d++) {
    const prime = PRIMES[d % PRIMES.length]!;
    const angle = (communityId * prime) / tc;
    vec[d] = d % 2 === 0 ? Math.sin(angle) : Math.cos(angle);
  }
  return vec;
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Buffer conversion helpers
// ---------------------------------------------------------------------------

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Copies the blob. The copy is deliberate and was re-measured 2026-09-15.
 *
 * A zero-copy `new Float32Array(buf.buffer, buf.byteOffset, len)` view does
 * work and does win: better-sqlite3 gave each of the 7,635 blobs on the real
 * 1,527-note vault its own exact-size ArrayBuffer (7,635 distinct buffers, 0
 * shared, 0 misaligned byteOffsets, 0 value mismatches against the copy), and
 * it took loadVectors from 35.0 ms to 23.0 ms warm while halving peak
 * ArrayBuffer bytes from 13.51 MiB to 6.84 MiB.
 *
 * It is still not worth it. loadVectors is 25 ms of a 3,344 ms warm query on
 * that vault - 0.7% - so the view buys 0.4% of a query in exchange for
 * handing out live views onto memory better-sqlite3 owns. Whether blobs stay
 * unshared is an implementation detail of the driver, not a contract, and the
 * failure mode is silently wrong vectors. Do not "optimize" this back without
 * a denominator that justifies it.
 */
function bufferToFloat32(buf: Buffer): Float32Array {
  const copy = new ArrayBuffer(buf.byteLength);
  const view = new Uint8Array(copy);
  view.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy);
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export async function indexNote(
  db: InstanceType<typeof Database>,
  title: string,
  frontmatter: Record<string, unknown>,
  body: string,
  linkGraph: LinkGraph,
  communities: Map<string, number>,
  totalCommunities: number,
  config: EngineConfig,
): Promise<void> {
  const enrichedText = buildKnowledgeEnrichedText(
    title,
    frontmatter,
    body,
    linkGraph,
  );
  const description =
    typeof frontmatter.description === "string"
      ? (frontmatter.description as string)
      : "";
  const noteType =
    typeof frontmatter.type === "string" ? (frontmatter.type as string) : "";
  const communityId = communities.get(title) ?? 0;

  const [titleVec, descVec, bodyVec] = await Promise.all([
    embedText(title, config),
    embedText(description || title, config),
    embedText(enrichedText, config),
  ]);

  const typeVec = encodeType(noteType);
  const communityVec = encodeCommunity(
    communityId,
    totalCommunities,
    config.community_dims,
  );

  const contentHashValue = hashContent(`${title}\n${description}\n${body}`);
  const indexedAt = new Date().toISOString();

  db.prepare(
    `INSERT OR REPLACE INTO embeddings
       (title, title_vec, desc_vec, body_vec, type_vec, community_vec, content_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    title,
    float32ToBuffer(titleVec),
    float32ToBuffer(descVec),
    float32ToBuffer(bodyVec),
    float32ToBuffer(typeVec),
    float32ToBuffer(communityVec),
    contentHashValue,
    indexedAt,
  );
}

export async function buildIndex(
  vaultRoot: string,
  config: EngineConfig,
  options?: { force?: boolean },
): Promise<IndexStats> {
  const start = Date.now();
  const notesDir = path.join(vaultRoot, "notes");
  const dbPath = path.resolve(vaultRoot, config.db_path);
  const db = initDB(dbPath);

  // Build link graph and communities
  const linkGraph = await buildGraph(notesDir);
  const graphMetrics = computeGraphMetrics(linkGraph);
  const totalCommunities = graphMetrics.communityStats.size;

  // Load existing hashes for skip detection
  const existingRows = db
    .prepare("SELECT title, content_hash FROM embeddings")
    .all() as Array<{ title: string; content_hash: string }>;
  const existingHashes = new Map(
    existingRows.map((r) => [r.title, r.content_hash]),
  );

  // Read all notes
  let files: string[];
  try {
    const dirents = await fs.readdir(notesDir, { withFileTypes: true });
    files = dirents
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name);
  } catch {
    files = [];
  }

  const activeNotes: Array<{
    title: string;
    frontmatter: Record<string, unknown>;
    body: string;
    contentHashValue: string;
  }> = [];

  for (const file of files) {
    const title = path.basename(file, ".md");
    const filePath = path.join(notesDir, file);
    const content = await fs.readFile(filePath, "utf8");
    const { data: frontmatter, body } = parseFrontmatter(content);
    const fm = frontmatter ?? {};

    if (fm.status === "archived") {
      continue;
    }

    const description =
      typeof fm.description === "string" ? (fm.description as string) : "";
    const contentHashValue = hashContent(
      `${title}\n${description}\n${body}`,
    );

    activeNotes.push({
      title,
      frontmatter: fm,
      body,
      contentHashValue,
    });
  }

  const activeTitles = new Set(activeNotes.map((note) => note.title));
  for (const title of existingHashes.keys()) {
    if (!activeTitles.has(title)) {
      removeNoteFromDB(db, title);
      existingHashes.delete(title);
    }
  }

  let indexed = 0;
  let skipped = 0;

  for (const note of activeNotes) {
    if (
      !options?.force &&
      existingHashes.get(note.title) === note.contentHashValue
    ) {
      skipped++;
      continue;
    }

    await indexNote(
      db,
      note.title,
      note.frontmatter,
      note.body,
      linkGraph,
      graphMetrics.communities,
      totalCommunities,
      config,
    );
    indexed++;
  }

  // Persist build timestamp so orient can surface index freshness
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
  ).run("built_at", new Date().toISOString());
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
  ).run("note_count", String(activeNotes.length));

  db.close();

  return {
    indexed,
    skipped,
    total: activeNotes.length,
    durationMs: Date.now() - start,
    model: config.embedding_model,
  };
}

// ---------------------------------------------------------------------------
// Community affinity
// ---------------------------------------------------------------------------

/** Neutral community score: what an orthogonal community vector earns. */
const COMMUNITY_NEUTRAL_SCORE = 0.5;

/**
 * How many top text matches vote for the query's community: 2% of the vault,
 * floored at 3 so a tiny vault still gets a vote and capped at 25 so a large
 * one does not average its whole graph back into a constant.
 */
const COMMUNITY_VOTE_FRACTION = 0.02;
const COMMUNITY_VOTE_MIN = 3;
const COMMUNITY_VOTE_MAX = 25;

export interface CommunityVote {
  textScore: number;
  vectors: { communityVec: Float32Array };
}

/**
 * Where in community space this query lives.
 *
 * The stored `community_vec` says which Louvain community a note belongs to,
 * but nothing said which community the *query* was asking about, so the
 * community space had no target to compare against and shipped the constant
 * 0.5 for four months. The target is recoverable from data already in hand:
 * the notes that match the query best on text are, by construction, the best
 * available evidence about which neighbourhoods of the graph the query is
 * in - so let them vote.
 *
 * Each of the top `k` text matches contributes its unit community vector,
 * weighted by the SQUARE of how far its text score exceeds the k-th (last)
 * voter's. Community vectors are shared by every note in a community, so the
 * sum concentrates on the communities the text hits actually cluster in, and
 * a query whose hits are scattered gets a flat affinity that barely separates
 * anyone - which is the honest answer for such a query.
 *
 * The weighting is not arbitrary; five were measured on the real 1,524-note
 * vault over 10 queries (top-10 window, community weight as each intent
 * profile sets it), against the constant-0.5 baseline "OFF":
 *
 *   weight                  same-community  nbrSim  quality  meanTextRank
 *   OFF (constant 0.5)              0.480   0.5545   0.0312          42.8
 *   textScore                       0.490   0.5402   0.0276          65.8
 *   textScore - kth                 0.510   0.5489   0.0299          49.8
 *   1 / (1 + rank)                  0.520   0.5560   0.0301          47.0
 *   softmax(T=0.05)                 0.530   0.5640   0.0320          68.9
 *   (textScore - kth)^2             0.540   0.5634   0.0313          57.0
 *
 * `same-community` is the share of the top 10 in the same Louvain community
 * as the best text hit; `nbrSim` is mean body-embedding cosine to that hit
 * (a graph-free relatedness check); `quality` is
 * `stage-tracker.measureCurrentQuality` over the top 20; `meanTextRank` is
 * how far down the text-only ordering the top 10 reaches, i.e. the cost of
 * the space in text relevance. Raw text score - the obvious choice - is the
 * worst option on record: it makes the largest community win regardless of
 * the query, because 25 near-equal weights average into the vault's bulk.
 * Squaring the excess makes the strongest hits dominate, which is what lifts
 * relatedness without paying softmax's text-relevance cost.
 *
 * Returns `null` when no vote is usable (empty vault, community column
 * pruned, every community vector zero, or every voter tied on text). Callers
 * must fall back to the neutral score, not to zero: `null` means "no
 * information", and the old constant is exactly the no-information answer.
 */
export function deriveCommunityAffinity(
  votes: ReadonlyArray<CommunityVote>,
  topK?: number,
): Float32Array | null {
  if (votes.length === 0) return null;
  const defaultK = Math.min(
    COMMUNITY_VOTE_MAX,
    Math.max(
      COMMUNITY_VOTE_MIN,
      Math.ceil(votes.length * COMMUNITY_VOTE_FRACTION),
    ),
  );
  const k = Math.max(1, Math.min(topK ?? defaultK, votes.length));

  // Bounded insertion beats sorting the whole vault to read 25 rows off it.
  const best: CommunityVote[] = [];
  for (const vote of votes) {
    if (best.length === k && vote.textScore <= best[k - 1]!.textScore) continue;
    let pos = best.length;
    while (pos > 0 && best[pos - 1]!.textScore < vote.textScore) pos--;
    best.splice(pos, 0, vote);
    if (best.length > k) best.pop();
  }

  const dims = best[0]!.vectors.communityVec.length;
  if (dims === 0) return null;

  // The marginal voter sets the baseline, so it weighs nothing and the
  // strongest hits weigh quadratically more.
  const baseline = best[best.length - 1]!.textScore;
  const affinity = new Float32Array(dims);
  let weightSum = 0;
  for (const vote of best) {
    const vec = vote.vectors.communityVec;
    if (vec.length !== dims) continue;
    const excess = vote.textScore - baseline;
    if (excess <= 0) continue;
    const weight = excess * excess;
    const norm = vectorNorm(vec);
    if (norm === 0) continue;
    for (let i = 0; i < dims; i++) {
      affinity[i]! += (vec[i]! / norm) * weight;
    }
    weightSum += weight;
  }

  if (weightSum === 0 || vectorNorm(affinity) === 0) return null;
  return affinity;
}

/**
 * How well one note's community matches the query's community affinity.
 *
 * Mapped from cosine's [-1, 1] onto [0, 1] so the space stays on the same
 * scale as the other five, all of which are cosines of non-negative vectors.
 * The midpoint is deliberate: an orthogonal community scores exactly the 0.5
 * this space used to hand everybody, so the composite scale is unchanged and
 * only the spread around it is new.
 *
 * A note with no community vector still scores 0, as before - absent data
 * earns nothing rather than earning the average.
 */
export function communityAffinityScore(
  affinity: Float32Array | null,
  communityVec: Float32Array,
): number {
  if (communityVec.length === 0 || vectorNorm(communityVec) === 0) return 0;
  if (affinity === null || affinity.length !== communityVec.length) {
    return COMMUNITY_NEUTRAL_SCORE;
  }
  return (cosine(affinity, communityVec) + 1) / 2;
}

// ---------------------------------------------------------------------------
// Composite search
// ---------------------------------------------------------------------------

interface StagedNote {
  title: string;
  vectors: StoredVectors;
  textScore: number;
}

export async function searchComposite(params: {
  queryText: string;
  intent: ClassifiedQuery;
  storedVectors: Map<string, StoredVectors>;
  graphMetrics: GraphMetrics;
  vitalityScores: Map<string, number>;
  limit: number;
  config: EngineConfig;
  /**
   * Precomputed embedding of `queryText`. Omit and it is embedded here; the
   * embedding is the only thing in this function that needs the model, so
   * supplying it makes composite scoring testable without loading 86 MB of
   * ONNX weights.
   */
  queryVec?: Float32Array;
}): Promise<ScoredNote[]> {
  const {
    queryText,
    intent,
    storedVectors,
    graphMetrics,
    vitalityScores,
    limit,
    config,
  } = params;

  // Embed query once
  const queryVec = params.queryVec ?? (await embedText(queryText, config));

  const sw = intent.spaceWeights;
  const splitW = intent.splitWeights;
  const bins = config.piecewise_bins;

  // Build query metadata target vectors (what we "want")
  const queryTemporalVec = encodePiecewiseLinear(1.0, bins); // want recent
  const queryVitalityVec = encodePiecewiseLinear(1.0, bins); // want alive
  const importanceTarget =
    intent.intent === "procedural" || intent.intent === "decision"
      ? 0.8
      : 0.5;
  const queryImportanceVec = encodePiecewiseLinear(importanceTarget, bins);
  // Loop-invariant: one vector and one clock reading for the whole scan,
  // instead of one of each per note.
  const queryTypeVec = buildQueryTypeVec(intent.intent);
  const nowMs = Date.now();

  // Max pagerank for normalization
  let maxPR = 0;
  for (const pr of graphMetrics.pagerank.values()) {
    if (pr > maxPR) maxPR = pr;
  }
  if (maxPR === 0) maxPR = 1;

  // Pass 1: text space only. The community target is derived from the best
  // text matches, so it cannot be known until every text score exists. This
  // is not a second pass over the vault - the expensive cosines happen once,
  // here, and pass 2 reuses them.
  const staged: StagedNote[] = [];
  for (const [title, vectors] of storedVectors) {
    const titleSim = cosine(queryVec, vectors.titleVec);
    const descSim = cosine(queryVec, vectors.descVec);
    const bodySim = cosine(queryVec, vectors.bodyVec);
    staged.push({
      title,
      vectors,
      textScore:
        splitW.title * titleSim +
        splitW.description * descSim +
        splitW.body * bodySim,
    });
  }

  const communityAffinity = deriveCommunityAffinity(staged);

  const results: ScoredNote[] = [];

  for (const { title, vectors, textScore } of staged) {
    // Type space: cosine between query-implied type vector and stored type
    const typeScore = cosine(queryTypeVec, vectors.typeVec);

    // Community space: similarity to the community affinity the query's own
    // top text matches voted for.
    const communityScore = communityAffinityScore(
      communityAffinity,
      vectors.communityVec,
    );

    // Temporal space: recency from indexedAt
    const indexedDate = new Date(vectors.indexedAt);
    const daysSinceIndex = Math.max(
      0,
      (nowMs - indexedDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const recency = Math.exp(-daysSinceIndex / 30); // 30-day half-life
    const temporalVec = encodePiecewiseLinear(recency, bins);
    const temporalScore = cosine(queryTemporalVec, temporalVec);

    // Vitality space
    const vitalityVal = vitalityScores.get(title) ?? 0.5;
    const vitalityVec = encodePiecewiseLinear(vitalityVal, bins);
    const vitalityScore = cosine(queryVitalityVec, vitalityVec);

    // Importance space (from PageRank, normalized)
    const pr = graphMetrics.pagerank.get(title) ?? 0;
    const normalizedPR = pr / maxPR;
    const importanceVec = encodePiecewiseLinear(normalizedPR, bins);
    const importanceScore = cosine(queryImportanceVec, importanceVec);

    // Final weighted composite
    const finalScore =
      sw.text * textScore +
      sw.temporal * temporalScore +
      sw.vitality * vitalityScore +
      sw.importance * importanceScore +
      sw.type * typeScore +
      sw.community * communityScore;

    results.push({
      title,
      score: finalScore,
      signals: { composite: finalScore },
      spaces: {
        text: textScore,
        temporal: temporalScore,
        vitality: vitalityScore,
        importance: importanceScore,
        type: typeScore,
        community: communityScore,
      },
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildQueryTypeVec(intent: string): Float32Array {
  const vec = new Float32Array(6);
  switch (intent) {
    case "decision":
      vec[1] = 1.0; // decision slot
      break;
    case "procedural":
      vec[2] = 0.7; // learning
      vec[3] = 0.3; // insight
      break;
    case "episodic":
      vec[0] = 0.3; // idea
      vec[2] = 0.4; // learning
      vec[3] = 0.3; // insight
      break;
    case "semantic":
    default:
      vec[0] = 0.3; // idea
      vec[2] = 0.3; // learning
      vec[3] = 0.4; // insight
      break;
  }
  return vec;
}

function vectorNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]! * v[i]!;
  }
  return Math.sqrt(sum);
}
