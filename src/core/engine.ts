import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { pipeline as hfPipeline } from "@huggingface/transformers";

import type { EngineConfig } from "./config.js";
import type { ClassifiedQuery } from "./intent.js";
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
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Vector loading
// ---------------------------------------------------------------------------

export function loadVectors(
  db: InstanceType<typeof Database>,
): Map<string, StoredVectors> {
  const rows = db
    .prepare(
      `SELECT title, title_vec, desc_vec, body_vec, type_vec, community_vec, content_hash, indexed_at FROM embeddings`,
    )
    .all() as Array<{
    title: string;
    title_vec: Buffer;
    desc_vec: Buffer;
    body_vec: Buffer;
    type_vec: Buffer;
    community_vec: Buffer;
    content_hash: string;
    indexed_at: string;
  }>;

  const map = new Map<string, StoredVectors>();
  for (const row of rows) {
    map.set(row.title, {
      titleVec: bufferToFloat32(row.title_vec),
      descVec: bufferToFloat32(row.desc_vec),
      bodyVec: bufferToFloat32(row.body_vec),
      typeVec: bufferToFloat32(row.type_vec),
      communityVec: bufferToFloat32(row.community_vec),
      contentHash: row.content_hash,
      indexedAt: row.indexed_at,
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
  body: string,
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

function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy to avoid shared ArrayBuffer alignment issues
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

  let indexed = 0;
  let skipped = 0;

  for (const file of files) {
    const title = path.basename(file, ".md");
    const filePath = path.join(notesDir, file);
    const content = await fs.readFile(filePath, "utf8");
    const { data: frontmatter, body } = parseFrontmatter(content);
    const fm = frontmatter ?? {};

    const description =
      typeof fm.description === "string" ? (fm.description as string) : "";
    const contentHashValue = hashContent(
      `${title}\n${description}\n${body}`,
    );

    if (!options?.force && existingHashes.get(title) === contentHashValue) {
      skipped++;
      continue;
    }

    await indexNote(
      db,
      title,
      fm,
      body,
      linkGraph,
      graphMetrics.communities,
      totalCommunities,
      config,
    );
    indexed++;
  }

  db.close();

  return {
    indexed,
    skipped,
    total: files.length,
    durationMs: Date.now() - start,
    model: config.embedding_model,
  };
}

// ---------------------------------------------------------------------------
// Composite search
// ---------------------------------------------------------------------------

export async function searchComposite(params: {
  queryText: string;
  intent: ClassifiedQuery;
  storedVectors: Map<string, StoredVectors>;
  graphMetrics: GraphMetrics;
  vitalityScores: Map<string, number>;
  limit: number;
  config: EngineConfig;
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
  const queryVec = await embedText(queryText, config);

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

  // Max pagerank for normalization
  let maxPR = 0;
  for (const pr of graphMetrics.pagerank.values()) {
    if (pr > maxPR) maxPR = pr;
  }
  if (maxPR === 0) maxPR = 1;

  const results: ScoredNote[] = [];

  for (const [title, vectors] of storedVectors) {
    // Text space: weighted split similarity
    const titleSim = cosine(queryVec, vectors.titleVec);
    const descSim = cosine(queryVec, vectors.descVec);
    const bodySim = cosine(queryVec, vectors.bodyVec);
    const textScore =
      splitW.title * titleSim +
      splitW.description * descSim +
      splitW.body * bodySim;

    // Type space: cosine between query-implied type vector and stored type
    const queryTypeVec = buildQueryTypeVec(intent.intent);
    const typeScore = cosine(queryTypeVec, vectors.typeVec);

    // Community space: use community vector norm as baseline signal
    // (full community-aware scoring needs query-time community detection)
    const communityScore = vectorNorm(vectors.communityVec) > 0 ? 0.5 : 0;

    // Temporal space: recency from indexedAt
    const indexedDate = new Date(vectors.indexedAt);
    const now = new Date();
    const daysSinceIndex = Math.max(
      0,
      (now.getTime() - indexedDate.getTime()) / (1000 * 60 * 60 * 24),
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
