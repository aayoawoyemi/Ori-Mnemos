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
import type Database from "better-sqlite3";
import { loadNoteIndex, loadAccess, recordAccess } from "./indexstore.js";

/** The derived index handle. Optional everywhere: the vault is the source of
 *  truth and every path here still works with no database at all. */
export type IndexDB = InstanceType<typeof Database>;

/**
 * Build a NoteIndex (frontmatter map) for all notes in a directory.
 *
 * `db` selects the persistent index instead of reading and YAML-parsing every
 * note. Measured 2026-09-15 on a 2,000-note vault: 859 ms of reads and parses
 * for this function alone, against 26.5 ms to load BOTH this and the link
 * graph out of SQLite. It is optional rather than required because the vault
 * is the source of truth and must stay readable with no index at all - a
 * caller with no database still gets the right answer, slowly.
 */
export async function buildNoteIndex(
  notesDir: string,
  titles: string[],
  db?: IndexDB,
): Promise<NoteIndex> {
  if (db) return loadNoteIndex(db);

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
 *
 * With `db` this reads `access_count` and `created` out of the index instead of
 * opening and YAML-parsing every note for two fields - the third full pass over
 * the vault that one ranked query used to make.
 *
 * Counter provenance, deliberately ordered: the live SQL counter wins where it
 * exists, and frontmatter is the fallback. Frontmatter is the durable copy
 * (issue #17: it "survives if the database is deleted or rebuilt") and
 * `flushAccessToFrontmatter` folds SQL into it on a maintenance pass, so the
 * fallback is the pre-flush baseline rather than a competing number.
 */
export async function computeAllVitality(
  notesDir: string,
  titles: string[],
  linkGraph: LinkGraph,
  bridges: Set<string>,
  config: OriConfig,
  boostScores?: Map<string, number>,
  db?: IndexDB,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const now = new Date();
  const indexed = db ? loadNoteIndex(db) : null;
  const liveAccess = db ? loadAccess(db) : null;

  for (const title of titles) {
    let accessCount = 0;
    let created = now.toISOString();

    const fromIndex = indexed?.frontmatter.get(title);
    if (fromIndex) {
      if (typeof fromIndex.created === "string") created = fromIndex.created;
      if (typeof fromIndex.access_count === "number") accessCount = fromIndex.access_count;
    } else {
      const filePath = path.join(notesDir, `${title}.md`);
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
    }

    const live = liveAccess?.get(title);
    if (live && live.access_count > accessCount) accessCount = live.access_count;

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
 * Record a retrieval access for each note.
 *
 * With `db` this is one SQLite transaction and touches no files. Without it,
 * the original behaviour: increment `access_count` and refresh `last_accessed`
 * in frontmatter (#17, fixed by @maichler in #33), so a vault with no index
 * still accumulates the ACT-R usage signal.
 *
 * Why the SQL path exists. The file path read-modify-writes ~11 of the user's
 * notes on EVERY ranked query, concurrently via `Promise.allSettled`, with no
 * lock. Three consequences, all measured or reasoned from the code:
 *   - two overlapping queries (CLI + MCP, or two MCP tools) lose an increment,
 *     because both read the same starting value;
 *   - a process death mid-write truncates a note - a read operation destroying
 *     user data;
 *   - `yaml.stringify` reserialises the whole block, so a QUERY silently
 *     normalises the key order and formatting of hand-authored frontmatter.
 * SQLite serialises the writers, so the counts are correct, and
 * `flushAccessToFrontmatter` puts them back in the durable store on a
 * maintenance pass instead of on the hot path.
 */
export async function recordNoteAccess(
  notesDir: string,
  titles: string[],
  db?: IndexDB,
): Promise<void> {
  if (db) {
    recordAccess(db, titles);
    return;
  }
  const today = new Date().toISOString().split("T")[0];
  await Promise.allSettled(
    titles.map(async (title) => {
      const notePath = path.join(notesDir, `${title}.md`);
      const { data, body } = await readFrontmatterFile(notePath);
      if (data) {
        data.access_count =
          (typeof data.access_count === "number" ? data.access_count : 0) + 1;
        data.last_accessed = today;
        await writeFrontmatterFile(notePath, data, body);
      }
    }),
  );
}
