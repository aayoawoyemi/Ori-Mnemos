/**
 * Shared note index and vitality computation.
 * Extracted from search.ts to enable reuse by prune.ts and other CLI modules.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import type { NoteIndex } from "./importance.js";
import type { LinkGraph } from "./graph.js";
import type { OriConfig } from "./config.js";
import {
  parseFrontmatter,
  readFrontmatterFile,
  writeFrontmatterFile,
} from "./frontmatter.js";
import { computeVitalityFull } from "./vitality.js";

/**
 * Build a NoteIndex (frontmatter map) for all notes in a directory.
 */
export async function buildNoteIndex(
  notesDir: string,
  titles: string[],
): Promise<NoteIndex> {
  const frontmatter = new Map<string, Record<string, unknown>>();

  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const { data } = parseFrontmatter(content);
      if (data) {
        frontmatter.set(title, data);
      }
    } catch {
      // skip unreadable files
    }
  }

  return { frontmatter };
}

/**
 * Compute vitality scores for all notes using the full ACT-R model.
 * Optionally accepts boost scores from spreading activation.
 */
export async function computeAllVitality(
  notesDir: string,
  titles: string[],
  linkGraph: LinkGraph,
  bridges: Set<string>,
  config: OriConfig,
  boostScores?: Map<string, number>,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const now = new Date();

  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    let accessCount = 0;
    let created = now.toISOString();

    try {
      const content = await fs.readFile(filePath, "utf8");
      const { data } = parseFrontmatter(content);
      if (data) {
        if (typeof data.access_count === "number") {
          accessCount = data.access_count;
        }
        if (typeof data.created === "string") {
          created = data.created;
        }
      }
    } catch {
      // use defaults
    }

    const inDegree = linkGraph.incoming.get(title)?.size ?? 0;

    const vitality = computeVitalityFull({
      accessCount,
      created,
      noteTitle: title,
      inDegree,
      bridges,
      metabolicRate: config.vitality.metabolic_rates?.notes ?? 1.0,
      actrDecay: config.vitality.actr_decay ?? 0.5,
      accessSaturationK: config.vitality.access_saturation_k ?? 10,
      bridgeFloor: config.graph.bridge_vitality_floor,
      activationBoost: boostScores?.get(title),
    });

    scores.set(title, vitality);
  }

  return scores;
}

/**
 * Record a retrieval access for each note: increment access_count and
 * refresh last_accessed in frontmatter. Best-effort — notes without
 * frontmatter, with parse errors, or unwritable files are skipped.
 *
 * This is the write-side of the ACT-R vitality model (#17): without it,
 * computeAllVitality reads access_count that nothing ever updates, so
 * every note decays at the same rate regardless of use. Frontmatter is
 * used (not the boosts table) so the signal survives DB rebuilds.
 *
 * Note: access_count is not part of the embedding content hash
 * (title/description/body), so these writes do not trigger re-embedding.
 */
export async function recordNoteAccess(
  notesDir: string,
  titles: string[],
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    try {
      const { data, body, errors } = await readFrontmatterFile(filePath);
      if (!data || errors.length > 0) continue;
      const current =
        typeof data.access_count === "number" && Number.isFinite(data.access_count)
          ? data.access_count
          : 0;
      data.access_count = current + 1;
      data.last_accessed = today;
      await writeFrontmatterFile(filePath, data, body);
    } catch {
      // best-effort: skip unreadable/unwritable notes
    }
  }
}
