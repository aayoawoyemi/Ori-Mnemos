import path from "node:path";
import { promises as fs, type Dirent } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph, findBacklinks, findDanglingLinks, findOrphans } from "../core/graph.js";
import { parseFrontmatter } from "../core/frontmatter.js";

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
