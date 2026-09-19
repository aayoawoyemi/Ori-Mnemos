/**
 * LongMemEval-S, retrieval track, session granularity.
 *
 * Why this benchmark and not LoCoMo: the official retrieval scorer
 * (src/evaluation/print_retrieval_metrics.py) imports sys, json and numpy and
 * nothing else. No LLM judge, no API key, $0.00 per run. LoCoMo's headline
 * numbers all come from a gpt-4o-mini judge that an independent audit found
 * accepts 62.81% of deliberately wrong answers, over a question set with a
 * 6.4% wrong-answer-key rate.
 *
 * This emits rankings only. The metrics are computed by the benchmark's own
 * evaluate_retrieval() via bench/longmemeval-score.py, so recall_all@k and
 * ndcg_any@k are the authors' definitions rather than a reimplementation --
 * a reimplementation is how you end up comparing against a number nobody else
 * computed.
 *
 * Usage:
 *   npx tsx bench/longmemeval-eval.ts --data /path/longmemeval_s_cleaned.json [--limit N]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { buildGraph } from "../src/core/graph.js";
import { computeGraphMetrics } from "../src/core/importance.js";
import type { GraphMetrics } from "../src/core/importance.js";
import { buildBM25Index, searchBM25 } from "../src/core/bm25.js";
import type { BM25Index } from "../src/core/bm25.js";
import { classifyIntent } from "../src/core/intent.js";
import { fuseScoreWeightedRRF } from "../src/core/fusion.js";
import type { SignalResults } from "../src/core/fusion.js";
import type { ScoredNote } from "../src/core/ranking.js";
import { applyConfigDefaults } from "../src/core/config.js";
import type { OriConfig } from "../src/core/config.js";
import type { LinkGraph } from "../src/core/graph.js";
import { buildIndex, initDB, loadVectors, searchComposite } from "../src/core/engine.js";

interface Turn { role: string; content: string }
interface Question {
  question_id: string;
  question_type: string;
  question: string;
  question_date?: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  haystack_dates?: string[];
}

const CONFIG_YAML = `vault:
  version: "0.3"
engine:
  embedding_model: "Xenova/all-MiniLM-L6-v2"
  embedding_dims: 384
  piecewise_bins: 8
  community_dims: 16
  db_path: ".ori/embeddings.db"
retrieval:
  default_limit: 10
  candidate_multiplier: 5
  rrf_k: 60
  signal_weights:
    composite: 2.0
    keyword: 1.0
    graph: 1.5
  exploration_budget: 0.0
bm25:
  k1: 1.2
  b: 0.75
  title_boost: 3.0
  description_boost: 2.0
`;

/** A session becomes one note. The note title IS the session id, so the
 *  ranking Ori returns maps to corpus ids without a second lookup table --
 *  the slug/rowid mismatch that silently zeroed an earlier measurement. */
async function buildVault(q: Question): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-lme-"));
  const notesDir = path.join(dir, "notes");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(path.join(dir, ".ori"), { recursive: true });
  await fs.writeFile(path.join(dir, "ori.config.yaml"), CONFIG_YAML, "utf-8");

  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const sid = q.haystack_session_ids[i];
    const date = q.haystack_dates?.[i] ?? "";
    const body = q.haystack_sessions[i]
      .map((t) => `**${t.role}:** ${t.content}`)
      .join("\n\n");
    const fm = `---\ndescription: "Conversation session ${sid}${date ? ` on ${date}` : ""}"\ncreated: ${(date || "2024-01-01").slice(0, 10)}\n---\n\n`;
    // Session ids are filesystem-safe hex; used verbatim so title === corpus id.
    await fs.writeFile(path.join(notesDir, `${sid}.md`), fm + body, "utf-8");
  }
  return dir;
}

interface Pipeline {
  config: OriConfig;
  linkGraph: LinkGraph;
  bm25Index: BM25Index;
  allTitles: string[];
  graphMetrics: GraphMetrics;
  vaultRoot: string;
  embeddings: boolean;
}

async function buildPipeline(vaultRoot: string): Promise<Pipeline> {
  const config = applyConfigDefaults({});
  const notesDir = path.join(vaultRoot, "notes");
  const files = await fs.readdir(notesDir);
  const allTitles = files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));

  const linkGraph = await buildGraph(notesDir);
  const graphMetrics = computeGraphMetrics(linkGraph);
  // buildBM25Index takes parsed docs, not a directory.
  const docs: Array<{ title: string; description: string; body: string }> = [];
  for (const title of allTitles) {
    const content = await fs.readFile(path.join(notesDir, title + ".md"), "utf-8");
    const lines = content.split(/\r?\n/);
    let bodyStart = 0;
    if (lines[0] === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") { bodyStart = i + 1; break; }
      }
    }
    const descMatch = content.match(/^description:\s*(.+)$/m);
    docs.push({
      title,
      description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "",
      body: lines.slice(bodyStart).join("\n"),
    });
  }
  const bm25Index = buildBM25Index(docs, config.bm25);

  let embeddings = false;
  try {
    await buildIndex(vaultRoot, config.engine, { force: true });
    embeddings = true;
  } catch { /* lexical + graph only */ }

  return { config, linkGraph, bm25Index, allTitles, graphMetrics, vaultRoot, embeddings };
}

/** Same fusion the product uses: BM25 + composite embedding, RRF. */
async function rank(p: Pipeline, query: string, topK: number): Promise<string[]> {
  const classified = classifyIntent(query, p.allTitles);
  const candidateLimit = Math.max(topK, topK * p.config.retrieval.candidate_multiplier);

  const bm25Results = searchBM25(query, p.bm25Index, p.config.bm25, candidateLimit);

  let composite: ScoredNote[] = [];
  if (p.embeddings) {
    try {
      const db = initDB(path.resolve(p.vaultRoot, p.config.engine.db_path));
      const storedVectors = loadVectors(db);
      db.close();
      const vitality = new Map<string, number>();
      for (const t of p.allTitles) vitality.set(t, 0.7);
      composite = await searchComposite({
        queryText: query,
        intent: classified,
        storedVectors,
        graphMetrics: p.graphMetrics,
        vitalityScores: vitality,
        limit: candidateLimit,
        config: p.config.engine,
      });
    } catch { /* continue lexical-only */ }
  }

  const signals: SignalResults = { composite, keyword: bm25Results, graph: [], warmth: [] };
  const fused = fuseScoreWeightedRRF(signals, p.config.retrieval);
  return fused.slice(0, topK).map((r) => r.title);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataPath = arg("--data") ?? "/tmp/lme/data/longmemeval_s_cleaned.json";
  const limit = Number(arg("--limit") ?? "0");
  const topK = Number(arg("--topk") ?? "50");

  process.stderr.write(`loading ${dataPath}\n`);
  const all = JSON.parse(await fs.readFile(dataPath, "utf-8")) as Question[];
  const questions = limit > 0 ? all.slice(0, limit) : all;
  process.stderr.write(`${questions.length} questions, topK=${topK}\n`);

  const out: Array<Record<string, unknown>> = [];
  const started = Date.now();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const vault = await buildVault(q);
    try {
      const p = await buildPipeline(vault);
      const ranked = await rank(p, q.question, topK);

      // corpus_ids in ranked order; rankings are indices into it. The official
      // evaluate_retrieval takes (rankings, correct_docs, corpus_ids), so
      // handing it an already-ordered corpus keeps the mapping trivial.
      out.push({
        question_id: q.question_id,
        question_type: q.question_type,
        corpus_ids: ranked,
        rankings: ranked.map((_, idx) => idx),
        correct_docs: q.answer_session_ids,
        n_sessions: q.haystack_session_ids.length,
      });
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }

    if ((i + 1) % 10 === 0 || i === questions.length - 1) {
      const el = (Date.now() - started) / 1000;
      const rate = (i + 1) / el;
      process.stderr.write(
        `  ${i + 1}/${questions.length}  ${el.toFixed(0)}s  ${rate.toFixed(2)} q/s  eta ${((questions.length - i - 1) / rate).toFixed(0)}s\n`,
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join("bench", "results", `longmemeval-rankings-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(out), "utf-8");
  process.stderr.write(`\nrankings written: ${outPath}\n`);
  process.stdout.write(outPath + "\n");
}

void main();
