import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

export type LinkGraph = {
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
};

export async function buildGraph(notesDir: string): Promise<LinkGraph> {
  let files: Dirent[];
  try {
    files = await fs.readdir(notesDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { outgoing: new Map(), incoming: new Map() };
    }
    throw err;
  }
  const markdownFiles = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(notesDir, entry.name));

  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  for (const filePath of markdownFiles) {
    const title = path.basename(filePath, ".md");
    const content = await fs.readFile(filePath, "utf8");
    const links = new Set<string>();

    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1]?.trim();
      if (target && target.length > 0) {
        links.add(target);
      }
    }

    outgoing.set(title, links);
    for (const target of links) {
      if (!incoming.has(target)) incoming.set(target, new Set());
      incoming.get(target)!.add(title);
    }
  }

  return { outgoing, incoming };
}

export function findOrphans(graph: LinkGraph, allNotes: string[]): string[] {
  return allNotes.filter((note) => !graph.incoming.has(note));
}

export function findDanglingLinks(graph: LinkGraph, allNotes: string[]): string[] {
  const existing = new Set(allNotes);
  const dangling = new Set<string>();
  for (const [_, links] of graph.outgoing) {
    for (const target of links) {
      if (!existing.has(target)) {
        dangling.add(target);
      }
    }
  }
  return Array.from(dangling).sort();
}

export function findBacklinks(graph: LinkGraph, note: string): string[] {
  return Array.from(graph.incoming.get(note) ?? []).sort();
}
