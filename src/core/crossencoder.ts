/**
 * Cross-encoder reranking — Layer 1.5 of retrieval intelligence.
 *
 * A cross-encoder jointly encodes (query, document) pairs and scores
 * relevance directly, instead of comparing precomputed embeddings.
 * "Rethinking Retrieval" (arXiv 2511.18177) measured +59% absolute
 * improvement at k_initial=10 / k_final=5 in agentic RAG pipelines.
 *
 * Slots between the dampening stages (Phase A output) and Q-value
 * reranking (Phase B): semantic precision first, learned utility second.
 *
 * Local-first discipline: the model (~90MB, default
 * Xenova/ms-marco-MiniLM-L-6-v2) downloads on first use, so the stage is
 * OFF by default and enabled via config (rerank.enabled: true).
 */

import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import type { ScoredNote } from "./ranking.js";
import type { RerankConfig } from "./config.js";

/** Scores one (query, document) pair; higher = more relevant. */
export type PairScorer = (query: string, doc: string) => Promise<number>;

let cachedModel: unknown = null;
let cachedTokenizer: unknown = null;
let cachedRankerModel: string | null = null;

/**
 * HF-backed scorer with the same lazy-cache pattern as embedText.
 *
 * ms-marco cross-encoders emit a SINGLE logit. The text-classification
 * pipeline would softmax that lone label to a constant 1.0, so we run the
 * model directly and apply sigmoid to the raw logit.
 */
export async function createCrossEncoderScorer(
  config: RerankConfig,
): Promise<PairScorer> {
  if (!cachedModel || cachedRankerModel !== config.model) {
    // Cast rationale (same as embedText): the transformers.js overload
    // unions are too complex for TS to resolve.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cachedTokenizer = await (AutoTokenizer as any).from_pretrained(config.model);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cachedModel = await (AutoModelForSequenceClassification as any).from_pretrained(
      config.model,
      { dtype: "fp32" },
    );
    cachedRankerModel = config.model;
  }
  return async (query: string, doc: string): Promise<number> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs = await (cachedTokenizer as any)(query, {
      text_pair: doc,
      padding: true,
      truncation: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { logits } = await (cachedModel as any)(inputs);
    const raw = Number(logits.data[0]);
    return 1 / (1 + Math.exp(-raw)); // sigmoid -> (0,1)
  };
}

/**
 * Rerank the top-K candidates with a pair scorer, blending cross-encoder
 * relevance with the fused pipeline score:
 *
 *   final = (1 - blend) * pipelineScoreNorm + blend * crossEncoderScore
 *
 * Candidates beyond top_k keep their order below the reranked head.
 * Pure function — the scorer is injected, so tests need no model.
 */
export async function rerankCrossEncoder(
  query: string,
  candidates: ScoredNote[],
  getText: (note: ScoredNote) => string,
  scorer: PairScorer,
  config: RerankConfig,
): Promise<ScoredNote[]> {
  if (candidates.length === 0) return candidates;
  const k = Math.min(config.top_k, candidates.length);
  const head = candidates.slice(0, k);
  const tail = candidates.slice(k);

  const maxPipe = Math.max(...head.map((c) => c.score), 1e-9);
  const blend = Math.min(1, Math.max(0, config.blend));

  const rescored = await Promise.all(
    head.map(async (note) => {
      const ceScore = await scorer(query, getText(note));
      const pipeNorm = note.score / maxPipe;
      return {
        ...note,
        score: (1 - blend) * pipeNorm + blend * ceScore,
        signals: { ...note.signals, cross_encoder: ceScore },
      };
    }),
  );
  rescored.sort((a, b) => b.score - a.score);

  // Tail scores are on the raw pipeline scale; rescale below the head floor
  // so global ordering stays monotone.
  const headFloor = rescored.length > 0 ? rescored[rescored.length - 1].score : 0;
  const maxTail = Math.max(...tail.map((t) => t.score), 1e-9);
  const rescaledTail = tail.map((t) => ({
    ...t,
    score: headFloor * 0.99 * (t.score / maxTail),
  }));

  return [...rescored, ...rescaledTail];
}
