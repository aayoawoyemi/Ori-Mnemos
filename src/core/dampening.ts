/**
 * Post-fusion dampening stages from Drift's ablation-validated pipeline.
 * Three simple, formula-complete stages that need no research — just build.
 *
 * 1. Gravity dampening: halve score for semantic matches with zero term overlap
 * 2. Hub dampening: penalize top 10% by edge count (P90 degree penalty)
 * 3. Resolution boost: 1.25x for decision/learning/procedural notes
 *
 * Research: Drift-Memory 8-stage pipeline (ablation P@5 deltas)
 */

import type { ScoredNote } from "./ranking.js";
import type { LinkGraph } from "./graph.js";

// --- Stopwords for gravity dampening ---

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "don", "now", "and", "but", "or", "if", "while", "about", "what",
  "which", "who", "whom", "this", "that", "these", "those", "am", "it",
  "its", "my", "your", "his", "her", "our", "their", "i", "me", "we",
  "you", "he", "she", "they", "them", "up",
]);

// --- Gravity Dampening (Drift P@5 delta: -0.256) ---

/**
 * Extract key terms from text, minus stopwords.
 */
export function extractKeyTerms(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Gravity dampening: halve score for high-scoring semantic matches
 * that have zero query term overlap with the note title.
 *
 * Catches "cosine similarity ghosts" — notes that score high on
 * embedding similarity but don't actually contain the information.
 */
export function applyGravityDampening(
  results: ScoredNote[],
  query: string,
  _noteTitles: Map<string, string>, // noteId -> title (kept for API stability)
  threshold: number = 0.3,
): ScoredNote[] {
  const queryTerms = extractKeyTerms(query);
  if (queryTerms.size === 0) return results;

  return results.map((note) => {
    if (note.score <= threshold) return note;

    // Check term overlap against note title (which IS the note ID in Ori)
    const titleTerms = extractKeyTerms(note.title);
    let overlap = 0;
    for (const term of queryTerms) {
      if (titleTerms.has(term)) {
        overlap++;
        break; // any overlap is enough
      }
    }

    if (overlap === 0) {
      return { ...note, score: note.score * 0.5 };
    }
    return note;
  });
}

// --- Hub Dampening (Drift P@5 delta: -0.104) ---

/**
 * Hub dampening: penalize notes in the top 10% by edge count.
 * Prevents map/index notes from dominating every query.
 *
 * Formula:
 *   P90 = degree at 90th percentile
 *   ratio = (degree - P90) / (maxDegree - P90)
 *   penalty = 1.0 - 0.6 * ratio
 *   score *= max(0.2, penalty)
 *
 * Entity-matched notes (present in query entities) are exempt.
 */
export function applyHubDampening(
  results: ScoredNote[],
  linkGraph: LinkGraph,
  queryEntities: string[] = [],
): ScoredNote[] {
  // Compute degree for all notes in the graph
  const degrees = new Map<string, number>();
  for (const [node, targets] of linkGraph.outgoing) {
    degrees.set(node, (degrees.get(node) ?? 0) + targets.size);
  }
  for (const [node, sources] of linkGraph.incoming) {
    degrees.set(node, (degrees.get(node) ?? 0) + sources.size);
  }

  // Get all degree values and find P90
  const allDegrees = [...degrees.values()].sort((a, b) => a - b);
  if (allDegrees.length === 0) return results;

  const p90Index = Math.floor(allDegrees.length * 0.9);
  const p90 = allDegrees[p90Index] ?? 0;
  const maxDeg = allDegrees[allDegrees.length - 1] ?? 0;

  if (maxDeg <= p90) return results; // no hubs to dampen

  const entitySet = new Set(queryEntities.map((e) => e.toLowerCase()));

  return results.map((note) => {
    const degree = degrees.get(note.title) ?? 0;
    if (degree <= p90) return note; // not a hub

    // Entity-matched notes are exempt
    if (entitySet.has(note.title.toLowerCase())) return note;

    const ratio = (degree - p90) / (maxDeg - p90);
    const penalty = 1.0 - 0.6 * ratio;
    const dampened = note.score * Math.max(0.2, penalty);

    return { ...note, score: dampened };
  });
}

// --- Resolution Boost (Drift P@5 delta: -0.144) ---

const RESOLUTION_TYPES = new Set([
  "decision",
  "learning",
]);

/**
 * Resolution boost: 1.25x score for notes typed as decisions,
 * learnings, or procedural fixes. These are actionable knowledge.
 */
export function applyResolutionBoost(
  results: ScoredNote[],
  noteTypes: Map<string, string>, // noteId -> type
  boost: number = 1.25,
): ScoredNote[] {
  return results.map((note) => {
    const noteType = noteTypes.get(note.title);
    if (noteType && RESOLUTION_TYPES.has(noteType.toLowerCase())) {
      return { ...note, score: note.score * boost };
    }
    return note;
  });
}
