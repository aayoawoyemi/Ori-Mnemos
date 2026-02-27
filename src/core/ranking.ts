export interface ScoredNote {
  title: string;
  score: number;
  signals: {
    composite?: number;
    keyword?: number;
    graph?: number;
    rrf?: number;
  };
  spaces?: {
    text: number;
    temporal: number;
    vitality: number;
    importance: number;
    type: number;
    community: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Rank notes by graph importance (PageRank scores).
 */
export function rankByImportance(
  notes: string[],
  pagerankScores: Map<string, number>,
  limit?: number
): ScoredNote[] {
  const scored: ScoredNote[] = notes.map((title) => ({
    title,
    score: pagerankScores.get(title) ?? 0,
    signals: { graph: pagerankScores.get(title) ?? 0 },
  }));

  scored.sort((a, b) => b.score - a.score);
  return limit ? scored.slice(0, limit) : scored;
}

/**
 * Find notes that are fading (below vitality threshold).
 * Sorted ascending — most fading first.
 */
export function rankByFading(
  notes: string[],
  vitalityScores: Map<string, number>,
  threshold: number = 0.3
): ScoredNote[] {
  const fading: ScoredNote[] = [];

  for (const title of notes) {
    const vitality = vitalityScores.get(title) ?? 0;
    if (vitality < threshold) {
      fading.push({
        title,
        score: vitality,
        signals: { composite: vitality },
      });
    }
  }

  // Sort ascending — lowest vitality first (most fading)
  fading.sort((a, b) => a.score - b.score);
  return fading;
}

/**
 * Rank notes by vitality score (descending).
 */
export function rankByVitality(
  notes: string[],
  vitalityScores: Map<string, number>,
  limit?: number
): ScoredNote[] {
  const scored: ScoredNote[] = notes.map((title) => ({
    title,
    score: vitalityScores.get(title) ?? 0,
    signals: { composite: vitalityScores.get(title) ?? 0 },
  }));

  scored.sort((a, b) => b.score - a.score);
  return limit ? scored.slice(0, limit) : scored;
}
