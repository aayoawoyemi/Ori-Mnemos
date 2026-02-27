import { existsSync } from "node:fs";
import path from "node:path";

import type { EngineConfig } from "./config.js";
import { initDB, loadVectors, cosine } from "./engine.js";
import type { LinkGraph } from "./graph.js";

export type DetectedLink = {
  title: string;
  offset: number;
  length: number;
  alreadyLinked: boolean;
};

export type LinkSuggestion = {
  title: string;
  reason:
    | "title-match"
    | "tag-overlap"
    | "project-overlap"
    | "shared-neighborhood"
    | "semantic-similarity";
  confidence: number;
};

export type VaultIndex = {
  titles: string[];
  frontmatter: Map<string, Record<string, unknown>>;
  graph: LinkGraph;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex that matches a note title in body text.
 * Slug-aware: dashes in titles also match spaces, and vice versa.
 */
function titleToPattern(title: string): RegExp {
  // Replace dashes with a pattern that matches dash or space
  const flexible = escapeRegex(title).replace(/-/g, "[-\\s]");
  return new RegExp(`\\b${flexible}\\b`, "gi");
}

/**
 * Check if the match at `offset` is already inside [[...]]
 */
function isInsideWikiLink(body: string, offset: number): boolean {
  // Walk backwards from offset looking for [[ without ]]
  let i = offset - 1;
  while (i >= 1) {
    if (body[i] === "[" && body[i - 1] === "[") {
      // Found [[ before this position — check no ]] between [[ and offset
      const between = body.slice(i + 1, offset);
      if (!between.includes("]]")) {
        return true;
      }
    }
    if (body[i] === "]" && i > 0 && body[i - 1] === "]") {
      // Found ]] before reaching [[, so we're not inside a link
      break;
    }
    i--;
  }
  return false;
}

/**
 * Scan body text for mentions of existing note titles.
 * Returns detected mentions sorted by offset.
 * Skips mentions already wrapped in [[]].
 */
export function detectLinks(
  body: string,
  existingTitles: string[]
): DetectedLink[] {
  // Sort longest first to avoid partial matches
  const sorted = [...existingTitles].sort((a, b) => b.length - a.length);
  const results: DetectedLink[] = [];
  const covered = new Set<number>(); // track covered character positions

  for (const title of sorted) {
    if (title.length === 0) continue;
    const pattern = titleToPattern(title);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(body)) !== null) {
      const offset = match.index;
      const length = match[0].length;

      // Skip if any position in this range is already covered
      let overlaps = false;
      for (let p = offset; p < offset + length; p++) {
        if (covered.has(p)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const alreadyLinked = isInsideWikiLink(body, offset);
      results.push({ title, offset, length, alreadyLinked });

      // Mark positions as covered
      for (let p = offset; p < offset + length; p++) {
        covered.add(p);
      }
    }
  }

  return results.sort((a, b) => a.offset - b.offset);
}

/**
 * Apply detected links to body text, wrapping unlinked mentions in [[]].
 * Processes from end to start to preserve offsets.
 */
export function applyLinks(body: string, links: DetectedLink[]): string {
  // Filter to only unlinked, sort by offset descending
  const toApply = links
    .filter((l) => !l.alreadyLinked)
    .sort((a, b) => b.offset - a.offset);

  let result = body;
  for (const link of toApply) {
    const before = result.slice(0, link.offset);
    const after = result.slice(link.offset + link.length);
    result = `${before}[[${link.title}]]${after}`;
  }
  return result;
}

/**
 * Suggest structural connections via graph heuristics.
 * No LLM — pure computation over vault metadata and link graph.
 */
export function suggestLinks(
  frontmatter: Record<string, unknown>,
  body: string,
  vaultIndex: VaultIndex
): LinkSuggestion[] {
  const suggestions = new Map<string, LinkSuggestion>();
  const noteProject = Array.isArray(frontmatter.project)
    ? (frontmatter.project as string[])
    : [];
  const noteTags = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as string[])
    : [];

  // Title match suggestions (from detectLinks)
  const detected = detectLinks(body, vaultIndex.titles);
  for (const link of detected) {
    if (!link.alreadyLinked) {
      suggestions.set(link.title, {
        title: link.title,
        reason: "title-match",
        confidence: 0.9,
      });
    }
  }

  // Project overlap
  if (noteProject.length > 0) {
    for (const [title, fm] of vaultIndex.frontmatter) {
      if (suggestions.has(title)) continue;
      const otherProject = Array.isArray(fm.project)
        ? (fm.project as string[])
        : [];
      const overlap = noteProject.filter((p) => otherProject.includes(p));
      if (overlap.length > 0) {
        suggestions.set(title, {
          title,
          reason: "project-overlap",
          confidence: 0.6 + overlap.length * 0.1,
        });
      }
    }
  }

  // Tag overlap
  if (noteTags.length > 0) {
    for (const [title, fm] of vaultIndex.frontmatter) {
      if (suggestions.has(title)) continue;
      const otherTags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
      const overlap = noteTags.filter((t) => otherTags.includes(t));
      if (overlap.length > 0) {
        suggestions.set(title, {
          title,
          reason: "tag-overlap",
          confidence: 0.5 + overlap.length * 0.1,
        });
      }
    }
  }

  // Shared neighborhood (triangle closing)
  // If the new note links to X, and Y also links to X (or X links to Y),
  // suggest Y as a connection.
  const myLinks = new Set(
    detected.filter((d) => !d.alreadyLinked).map((d) => d.title)
  );
  for (const linkedTitle of myLinks) {
    // Find other notes that also link to linkedTitle
    const coLinkers = vaultIndex.graph.incoming.get(linkedTitle);
    if (coLinkers) {
      for (const coLinker of coLinkers) {
        if (suggestions.has(coLinker) || myLinks.has(coLinker)) continue;
        suggestions.set(coLinker, {
          title: coLinker,
          reason: "shared-neighborhood",
          confidence: 0.5,
        });
      }
    }
    // Find notes that linkedTitle links to
    const outgoing = vaultIndex.graph.outgoing.get(linkedTitle);
    if (outgoing) {
      for (const target of outgoing) {
        if (suggestions.has(target) || myLinks.has(target)) continue;
        suggestions.set(target, {
          title: target,
          reason: "shared-neighborhood",
          confidence: 0.45,
        });
      }
    }
  }

  return Array.from(suggestions.values()).sort(
    (a, b) => b.confidence - a.confidence
  );
}

/**
 * Extend suggestLinks with a 5th signal: semantic similarity.
 * Loads the embedding index (if it exists) and computes cosine similarity
 * between the current note's title vector and all other notes.
 * Falls back gracefully to base suggestions when the index is unavailable.
 */
export function suggestLinksWithSemantic(
  noteTitle: string,
  frontmatter: Record<string, unknown>,
  body: string,
  vaultIndex: VaultIndex,
  vaultRoot: string,
  engineConfig: EngineConfig,
): LinkSuggestion[] {
  // 1. Get base suggestions from existing heuristics
  const suggestions = suggestLinks(frontmatter, body, vaultIndex);
  const existingTitles = new Set(suggestions.map((s) => s.title));

  // 2. Try semantic similarity from the embedding index
  const dbPath = path.resolve(vaultRoot, engineConfig.db_path);
  if (!existsSync(dbPath)) return suggestions;

  try {
    const db = initDB(dbPath);
    const vectors = loadVectors(db);
    db.close();

    const noteVec = vectors.get(noteTitle);
    if (!noteVec) return suggestions;

    // Compute cosine similarity of title vectors against all other notes
    const similarities: Array<{ title: string; similarity: number }> = [];
    for (const [title, stored] of vectors) {
      if (title === noteTitle) continue;
      if (existingTitles.has(title)) continue; // already suggested
      const sim = cosine(noteVec.titleVec, stored.titleVec);
      if (sim > 0.5) {
        similarities.push({ title, similarity: sim });
      }
    }

    // Sort by similarity descending, take top 5
    similarities.sort((a, b) => b.similarity - a.similarity);
    for (const { title, similarity } of similarities.slice(0, 5)) {
      suggestions.push({
        title,
        reason: "semantic-similarity",
        confidence: Math.min(0.95, similarity), // cap confidence
      });
    }
  } catch {
    // Graceful fallback — semantic search is optional
  }

  // Re-sort all suggestions by confidence
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions;
}
