export type NoteType =
  | "idea"
  | "decision"
  | "learning"
  | "insight"
  | "blocker"
  | "opportunity";

const VALID_TYPES: Set<string> = new Set([
  "idea",
  "decision",
  "learning",
  "insight",
  "blocker",
  "opportunity",
]);

export type ClassificationResult = {
  type: NoteType;
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type ProjectKeywordConfig = {
  known_projects: string[];
  keywords: Record<string, string[]>;
};

type PatternRule = {
  type: NoteType;
  patterns: RegExp[];
};

// Priority-ordered: first match wins.
// Patterns test against lowercased title + body combined.
const PATTERN_RULES: PatternRule[] = [
  {
    type: "decision",
    patterns: [
      /\bchose\s+\w+\s+over\b/,
      /\bdecided\s+to\b/,
      /\bswitched\s+from\b/,
      /\bwill\s+use\b/,
      /\bapproved\b/,
      /\bgo\s+with\b/,
      /\bdecision\b/,
      /\btrade-?off\b/,
      /\balternatives?\b/,
      /\brationale\b/,
    ],
  },
  {
    type: "blocker",
    patterns: [
      /\bblocked?\b/,
      /\bblocker\b/,
      /\bstuck\b/,
      /\bcan'?t\s+proceed\b/,
      /\bcannot\s+proceed\b/,
      /\bwaiting\s+on\b/,
      /\bdepends\s+on\b/,
    ],
  },
  {
    type: "opportunity",
    patterns: [
      /\bopportunity\b/,
      /\bpotential\b/,
      /\bmight\s+enable\b/,
      /\bopens\s+up\b/,
      /\bworth\s+exploring\b/,
      /\bgap\b/,
      /\bnobody\s+has\b/,
      /\bmarket\s+for\b/,
    ],
  },
  {
    type: "learning",
    patterns: [
      /\blearned\b/,
      /\bdiscovered\s+that\b/,
      /\bturns\s+out\b/,
      /\brealized\b/,
      /\bTIL\b/i,
      /\bkey\s+takeaway\b/,
      /\bproves\b/,
    ],
  },
  {
    type: "idea",
    patterns: [
      /\bwhat\s+if\b/,
      /\bcould\s+we\b/,
      /\bproposal\b/,
      /\bhypothesis\b/,
      /\bexperiment\b/,
      /\bidea\b/,
    ],
  },
];

export function classifyNoteType(
  title: string,
  body: string,
  frontmatterType?: string
): ClassificationResult {
  // Priority 1: explicit frontmatter type
  if (frontmatterType && VALID_TYPES.has(frontmatterType)) {
    return {
      type: frontmatterType as NoteType,
      confidence: "high",
      reason: "explicit type in frontmatter",
    };
  }

  const text = `${title}\n${body}`.toLowerCase();

  for (const rule of PATTERN_RULES) {
    const matchCount = rule.patterns.filter((p) => p.test(text)).length;
    if (matchCount >= 2) {
      return {
        type: rule.type,
        confidence: "high",
        reason: `${matchCount} pattern matches for ${rule.type}`,
      };
    }
    if (matchCount === 1) {
      return {
        type: rule.type,
        confidence: "medium",
        reason: `1 pattern match for ${rule.type}`,
      };
    }
  }

  // Default fallback
  return {
    type: "insight",
    confidence: "low",
    reason: "no strong pattern match, defaulting to insight",
  };
}

export function detectProjects(
  title: string,
  body: string,
  config: ProjectKeywordConfig
): string[] {
  if (!config.keywords || Object.keys(config.keywords).length === 0) {
    return [];
  }

  const text = `${title}\n${body}`.toLowerCase();
  const matched: string[] = [];

  for (const [project, keywords] of Object.entries(config.keywords)) {
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        matched.push(project);
        break;
      }
    }
  }

  return matched.sort();
}
