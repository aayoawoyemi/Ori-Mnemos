import path from "node:path";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import {
  readFrontmatterFile,
  writeFrontmatterFile,
} from "../core/frontmatter.js";
import { buildGraph } from "../core/graph.js";
import { daysBetween } from "../core/vitality.js";

export type ArchiveOptions = {
  startDir: string;
  dryRun?: boolean;
};

export type ArchivedNote = {
  note: string;
  reason: string;
  daysSinceAccess: number;
  incomingLinks: number;
};

export type ArchiveResult = {
  success: boolean;
  data: {
    archived: ArchivedNote[];
  };
  warnings: string[];
};

/**
 * Determine if a note should be archived.
 * Old (60d) + isolated (<2 incoming links) = archive candidate.
 * Terminal status (completed/superseded) + 30d grace = archive faster.
 */
export function shouldArchive(
  frontmatter: Record<string, unknown>,
  incomingLinkCount: number,
  now: Date
): boolean {
  if (frontmatter.status === "archived") return false;

  const lastAccessed =
    typeof frontmatter.last_accessed === "string"
      ? frontmatter.last_accessed
      : typeof frontmatter.created === "string"
        ? frontmatter.created
        : null;
  if (typeof lastAccessed !== "string") return false;

  const accessDate = new Date(lastAccessed);
  if (isNaN(accessDate.getTime())) return false;

  const days = daysBetween(accessDate, now);
  const terminal = ["completed", "superseded"].includes(
    frontmatter.status as string
  );

  return (days > 60 && incomingLinkCount < 2) || (terminal && days > 30);
}

export async function runArchive(
  options: ArchiveOptions
): Promise<ArchiveResult> {
  const vaultRoot = await findVaultRoot(options.startDir);
  const paths = getVaultPaths(vaultRoot);
  await loadConfig(paths.config); // validate config exists

  const titles = await listNoteTitles(paths.notes);
  const graph = await buildGraph(paths.notes);
  const now = new Date();
  const archived: ArchivedNote[] = [];

  for (const title of titles) {
    const filePath = path.join(paths.notes, `${title}.md`);
    const parsed = await readFrontmatterFile(filePath);
    if (!parsed.data) continue;

    const incomingLinks = graph.incoming.get(title)?.size ?? 0;

    if (!shouldArchive(parsed.data, incomingLinks, now)) continue;

    const accessDateStr =
      typeof parsed.data.last_accessed === "string"
        ? parsed.data.last_accessed
        : (parsed.data.created as string);
    const days = Math.round(daysBetween(new Date(accessDateStr), now));
    const reason =
      ["completed", "superseded"].includes(parsed.data.status as string)
        ? `terminal status (${parsed.data.status}) + ${days}d since access`
        : `${days}d since access + ${incomingLinks} incoming link(s)`;

    if (!options.dryRun) {
      parsed.data.status = "archived";
      await writeFrontmatterFile(filePath, parsed.data, parsed.body);
    }

    archived.push({
      note: title,
      reason,
      daysSinceAccess: days,
      incomingLinks,
    });
  }

  return {
    success: true,
    data: { archived },
    warnings: [],
  };
}
