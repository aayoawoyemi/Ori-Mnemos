import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph, findDanglingLinks, findOrphans } from "../core/graph.js";
import { loadConfig, resolveTemplatePath } from "../core/config.js";
import { validateNoteAgainstSchema } from "../core/schema.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { computeVitality } from "../core/vitality.js";

export type HealthResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

export async function runHealth(startDir: string): Promise<HealthResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  const allNotes = await listNoteTitles(paths.notes);
  const graph = await buildGraph(paths.notes);
  const orphans = findOrphans(graph, allNotes);
  const dangling = findDanglingLinks(graph, allNotes);

  const schemaViolations: { note: string; errors: string[] }[] = [];
  const fading: { note: string; vitality: number }[] = [];

  for (const note of allNotes) {
    const filePath = path.join(paths.notes, `${note}.md`);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    const type =
      parsed.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)["type"]
        : null;

    const templatePath = resolveTemplatePath(
      config,
      vaultRoot,
      typeof type === "string" ? type : null
    );
    const validation = await validateNoteAgainstSchema(filePath, templatePath);
    if (!validation.valid) {
      schemaViolations.push({ note, errors: validation.errors });
    }

    const dataObj =
      parsed.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)
        : null;
    const lastAccessedRaw =
      typeof dataObj?.["last_accessed"] === "string"
        ? dataObj["last_accessed"]
        : typeof dataObj?.["created"] === "string"
          ? dataObj["created"]
          : null;
    if (typeof lastAccessedRaw === "string") {
      const last = new Date(lastAccessedRaw);
      if (!isNaN(last.getTime())) {
        const decayDays =
          typeof type === "string" && config.vitality.decay[type]
            ? config.vitality.decay[type]
            : 30;
        const vitality = computeVitality(
          { base: config.vitality.base, decayDays },
          last,
          new Date()
        );
        if (vitality < 0.2) {
          fading.push({ note, vitality });
        }
      }
    }
  }

  return {
    success: true,
    data: {
      noteCount: allNotes.length,
      orphanCount: orphans.length,
      danglingCount: dangling.length,
      orphans,
      dangling,
      schemaViolations,
      fading,
    },
    warnings: [],
  };
}
