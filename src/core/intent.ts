export type QueryIntent = "episodic" | "procedural" | "semantic" | "decision";

export interface SpaceWeights {
  text: number;
  temporal: number;
  vitality: number;
  importance: number;
  type: number;
  community: number;
}

export interface SplitWeights {
  title: number;
  description: number;
  body: number;
}

export interface ClassifiedQuery {
  intent: QueryIntent;
  confidence: number;
  query: string;
  entities: string[];
  spaceWeights: SpaceWeights;
  splitWeights: SplitWeights;
}

const INTENT_PATTERNS: Array<{ intent: QueryIntent; patterns: RegExp[] }> = [
  {
    intent: "episodic",
    patterns: [
      /\bwhen\s+did\b/i,
      /\blast\s+time\b/i,
      /\bwhat\s+happened\b/i,
      /\brecently\b/i,
      /\bhistory\s+of\b/i,
      /\btimeline\b/i,
      /\bwhen\s+was\b/i,
      /\bremember\s+when\b/i,
    ],
  },
  {
    intent: "procedural",
    patterns: [
      /\bhow\s+to\b/i,
      /\bsteps?\s+for\b/i,
      /\bprocess\b/i,
      /\bprocedure\b/i,
      /\binstructions?\b/i,
      /\bworkflow\b/i,
      /\bhow\s+do\b/i,
      /\bguide\b/i,
    ],
  },
  {
    intent: "decision",
    patterns: [
      /\bwhy\s+did\s+we\b/i,
      /\bdecision\b/i,
      /\bchose\b/i,
      /\bchoose\b/i,
      /\balternatives?\b/i,
      /\btrade-?off\b/i,
      /\brationale\b/i,
      /\bdecided\b/i,
    ],
  },
  // semantic is the default — no specific patterns needed
];

const SPACE_WEIGHTS: Record<QueryIntent, SpaceWeights> = {
  episodic:   { text: 0.40, temporal: 0.25, vitality: 0.15, importance: 0.05, type: 0.05, community: 0.10 },
  procedural: { text: 0.30, temporal: 0.05, vitality: 0.10, importance: 0.30, type: 0.10, community: 0.15 },
  semantic:   { text: 0.65, temporal: 0.05, vitality: 0.10, importance: 0.10, type: 0.05, community: 0.05 },
  decision:   { text: 0.30, temporal: 0.15, vitality: 0.10, importance: 0.10, type: 0.30, community: 0.05 },
};

const SPLIT_WEIGHTS: Record<QueryIntent, SplitWeights> = {
  semantic:   { title: 0.5, description: 0.3, body: 0.2 },
  episodic:   { title: 0.2, description: 0.2, body: 0.6 },
  decision:   { title: 0.4, description: 0.4, body: 0.2 },
  procedural: { title: 0.3, description: 0.3, body: 0.4 },
};

/**
 * Extract note title entities from query by fuzzy matching against known titles.
 */
function extractEntities(query: string, noteIndex: string[]): string[] {
  const queryLower = query.toLowerCase();
  const entities: string[] = [];

  for (const title of noteIndex) {
    const titleLower = title.toLowerCase();
    // Direct substring match
    if (queryLower.includes(titleLower) && titleLower.length >= 3) {
      entities.push(title);
    }
  }

  // Sort by length descending (prefer longer/more specific matches)
  return entities.sort((a, b) => b.length - a.length);
}

/**
 * Classify query intent using heuristic pattern matching.
 * Returns classified query with weight profiles for the retrieval engine.
 */
export function classifyIntent(
  query: string,
  noteIndex: string[] = []
): ClassifiedQuery {
  let bestIntent: QueryIntent = "semantic"; // default
  let bestScore = 0;

  for (const { intent, patterns } of INTENT_PATTERNS) {
    const matchCount = patterns.filter((p) => p.test(query)).length;
    if (matchCount > bestScore) {
      bestScore = matchCount;
      bestIntent = intent;
    }
  }

  const confidence = bestScore >= 2 ? 1.0 : bestScore === 1 ? 0.7 : 0.5;
  const entities = extractEntities(query, noteIndex);

  return {
    intent: bestIntent,
    confidence,
    query,
    entities,
    spaceWeights: SPACE_WEIGHTS[bestIntent],
    splitWeights: SPLIT_WEIGHTS[bestIntent],
  };
}

/**
 * Get space weight profile for a given intent.
 */
export function getSpaceWeights(intent: QueryIntent): SpaceWeights {
  return SPACE_WEIGHTS[intent];
}

/**
 * Get split vector weight profile for a given intent.
 */
export function getSplitWeights(intent: QueryIntent): SplitWeights {
  return SPLIT_WEIGHTS[intent];
}
