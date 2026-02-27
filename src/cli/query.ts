import path from "node:path";
import { promises as fs, type Dirent } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph, findBacklinks, findDanglingLinks, findOrphans } from "../core/graph.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { computeGraphMetrics } from "../core/importance.js";
import { rankByImportance, rankByFading } from "../core/ranking.js";
import { computeVitalityFull } from "../core/vitality.js";

export type QueryResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

export async function runQueryOrphans(startDir: string): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const allNotes = await listNoteTitles(notes);
  const graph = await buildGraph(notes);
  const orphans = findOrphans(graph, allNotes);

  return {
    success: true,
    data: { orphans },
    warnings: [],
  };
}

export async function runQueryDangling(startDir: string): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const allNotes = await listNoteTitles(notes);
  const graph = await buildGraph(notes);
  const dangling = findDanglingLinks(graph, allNotes);

  return {
    success: true,
    data: { dangling },
    warnings: [],
  };
}

export async function runQueryBacklinks(
  startDir: string,
  note: string
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const graph = await buildGraph(notes);
  const backlinks = findBacklinks(graph, note);

  return {
    success: true,
    data: { backlinks },
    warnings: [],
  };
}

export async function runQueryCrossProject(startDir: string): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(notes, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { success: true, data: { notes: [] }, warnings: [] };
    }
    throw err;
  }
  const results: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(notes, entry.name);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    if (!parsed.data) continue;
    const project = (parsed.data as Record<string, unknown>)["project"];
    if (Array.isArray(project) && project.length >= 2) {
      results.push(entry.name.replace(/\.md$/, ""));
    }
  }

  return {
    success: true,
    data: { notes: results },
    warnings: [],
  };
}

export async function runQueryImportant(
  startDir: string,
  limit?: number
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const allNotes = await listNoteTitles(notes);
  const graph = await buildGraph(notes);
  const metrics = computeGraphMetrics(graph);
  const results = rankByImportance(allNotes, metrics.pagerank, limit ?? 10);

  return {
    success: true,
    data: { results },
    warnings: [],
  };
}

export async function runQueryFading(
  startDir: string,
  threshold?: number,
  limit?: number
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes: notesDir } = getVaultPaths(vaultRoot);
  const allNotes = await listNoteTitles(notesDir);
  const graph = await buildGraph(notesDir);
  const metrics = computeGraphMetrics(graph);

  const vitalityScores = new Map<string, number>();

  for (const title of allNotes) {
    const filePath = path.join(notesDir, `${title}.md`);
    let accessCount = 0;
    let created = new Date().toISOString().slice(0, 10);

    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = parseFrontmatter(content);
      if (parsed.data) {
        const fm = parsed.data as Record<string, unknown>;
        if (typeof fm.access_count === "number") accessCount = fm.access_count;
        if (typeof fm.created === "string") created = fm.created;
      }
    } catch {
      // If file can't be read, use defaults
    }

    const inDegree = graph.incoming.get(title)?.size ?? 0;

    const vitality = computeVitalityFull({
      accessCount,
      created,
      noteTitle: title,
      inDegree,
      bridges: metrics.bridges,
    });

    vitalityScores.set(title, vitality);
  }

  const all = rankByFading(allNotes, vitalityScores, threshold ?? 0.3);
  const results = limit != null ? all.slice(0, limit) : all;

  return {
    success: true,
    data: { results },
    warnings: [],
  };
}
