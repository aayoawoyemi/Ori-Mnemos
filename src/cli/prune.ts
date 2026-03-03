/**
 * ori prune — Analyze activation topology and identify archive candidates.
 * Dry-run by default. --apply required to mutate files.
 */
import path from "node:path";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph } from "../core/graph.js";
import { loadConfig } from "../core/config.js";
import { initDB } from "../core/engine.js";
import {
  computeGraphMetrics,
  findBridgeNotes,
  buildGraphologyGraph,
} from "../core/importance.js";
import { buildNoteIndex, computeAllVitality } from "../core/noteindex.js";
import { loadBoosts } from "../core/activation.js";
import {
  classifyZone,
  DEFAULT_ZONE_THRESHOLDS,
  type VitalityZone,
  type ZoneThresholds,
} from "../core/vitality.js";
import { readFrontmatterFile, writeFrontmatterFile } from "../core/frontmatter.js";
import { promises as fs } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PruneOptions {
  startDir: string;
  dryRun?: boolean;   // default true
  verbose?: boolean;
}

export interface PruneCandidate {
  title: string;
  vitality: number;
  zone: VitalityZone;
  isArticulationPoint: boolean;
  inDegree: number;
  community: number;
  reason: string;
}

export interface PruneResult {
  success: boolean;
  data: {
    zones: { active: number; stale: number; fading: number; archived: number };
    total: number;
    articulationPoints: string[];
    candidates: PruneCandidate[];
    applied: boolean;
    archivedCount: number;
    hotspots: Array<{
      community: number;
      size: number;
      meanVitality: number;
      topMembers: string[];
    }>;
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runPrune(options: PruneOptions): Promise<PruneResult> {
  const { startDir, dryRun = true, verbose = false } = options;
  const warnings: string[] = [];

  // 1. Vault setup
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  // 2. Build link graph + graph metrics
  const linkGraph = await buildGraph(paths.notes);
  const allTitles = await listNoteTitles(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const graphMetrics = computeGraphMetrics(linkGraph, noteIndex);

  // 3. Load activation boosts from DB
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  let boostScores: Map<string, number> | undefined;
  try {
    await fs.access(dbPath);
    const db = initDB(dbPath);
    boostScores = loadBoosts(db);
    db.close();
  } catch {
    // DB doesn't exist yet — skip boosts
  }

  // 4. Compute vitality for all notes
  const vitalityScores = await computeAllVitality(
    paths.notes,
    allTitles,
    linkGraph,
    graphMetrics.bridges,
    config,
    boostScores,
  );

  // 5. Build zone thresholds from config
  const zt = config.vitality.zone_thresholds;
  const thresholds: ZoneThresholds = {
    active: zt?.active_floor ?? DEFAULT_ZONE_THRESHOLDS.active,
    stale: zt?.stale_floor ?? DEFAULT_ZONE_THRESHOLDS.stale,
    fading: zt?.fading_floor ?? DEFAULT_ZONE_THRESHOLDS.fading,
  };

  // 6. Classify each note and count zones
  const zones = { active: 0, stale: 0, fading: 0, archived: 0 };
  const noteZones = new Map<string, VitalityZone>();

  for (const title of allTitles) {
    const fm = noteIndex.frontmatter.get(title);
    const currentStatus = typeof fm?.status === "string" ? fm.status : undefined;
    const vitality = vitalityScores.get(title) ?? 0;
    const zone = classifyZone(vitality, currentStatus, thresholds);
    noteZones.set(title, zone);
    zones[zone]++;
  }

  // 7. Find articulation points
  const gGraph = buildGraphologyGraph(linkGraph);
  const bridges = findBridgeNotes(gGraph, noteIndex);
  const articulationPoints = Array.from(bridges).sort();

  // 8. Identify prune candidates
  const candidates: PruneCandidate[] = [];

  for (const title of allTitles) {
    const zone = noteZones.get(title)!;
    const fm = noteIndex.frontmatter.get(title);
    const currentStatus = typeof fm?.status === "string" ? fm.status : undefined;

    // Skip if already archived in frontmatter
    if (currentStatus === "archived") continue;

    // Only fading or archived-zone notes are candidates
    if (zone !== "fading" && zone !== "archived") continue;

    // Skip articulation points
    if (bridges.has(title)) continue;

    // Skip notes with inDegree >= 2
    const inDegree = linkGraph.incoming.get(title)?.size ?? 0;
    if (inDegree >= 2) continue;

    candidates.push({
      title,
      vitality: vitalityScores.get(title) ?? 0,
      zone,
      isArticulationPoint: false,
      inDegree,
      community: graphMetrics.communities.get(title) ?? -1,
      reason: zone === "archived"
        ? `vitality below fading floor (${thresholds.fading})`
        : `vitality in fading zone (${thresholds.fading}–${thresholds.stale})`,
    });
  }

  // 9. Apply if not dry-run
  let archivedCount = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      const filePath = path.join(paths.notes, `${candidate.title}.md`);
      try {
        const { data, body } = await readFrontmatterFile(filePath);
        const fm = data ?? {};
        fm.status = "archived";
        await writeFrontmatterFile(filePath, fm, body);
        archivedCount++;
      } catch {
        warnings.push(`Failed to archive: ${candidate.title}`);
      }
    }
  }

  // 10. Build community hotspots (top 5 by mean vitality)
  const communityVitalities = new Map<number, { total: number; count: number; members: string[] }>();
  for (const title of allTitles) {
    const communityId = graphMetrics.communities.get(title) ?? -1;
    const vitality = vitalityScores.get(title) ?? 0;
    if (!communityVitalities.has(communityId)) {
      communityVitalities.set(communityId, { total: 0, count: 0, members: [] });
    }
    const entry = communityVitalities.get(communityId)!;
    entry.total += vitality;
    entry.count++;
    entry.members.push(title);
  }

  const hotspots = Array.from(communityVitalities.entries())
    .map(([communityId, stats]) => ({
      community: communityId,
      size: stats.count,
      meanVitality: stats.total / stats.count,
      topMembers: stats.members
        .sort((a, b) => (vitalityScores.get(b) ?? 0) - (vitalityScores.get(a) ?? 0))
        .slice(0, 3),
    }))
    .sort((a, b) => b.meanVitality - a.meanVitality)
    .slice(0, 5);

  return {
    success: true,
    data: {
      zones,
      total: allTitles.length,
      articulationPoints,
      candidates,
      applied: !dryRun,
      archivedCount,
      hotspots,
    },
    warnings,
  };
}
