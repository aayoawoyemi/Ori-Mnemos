import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { slugify } from "./slug.js";

export type LinkGraph = {
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
};

export class GraphCache {
  private graph: LinkGraph | null = null;

  async get(notesDir: string): Promise<LinkGraph> {
    if (!this.graph) {
      this.graph = await buildGraph(notesDir);
    }
    return this.graph;
  }

  invalidate(): void {
    this.graph = null;
  }
}

/**
 * Strip CommonMark fenced code blocks (backtick or tilde, CommonMark §4.5)
 * before wikilink extraction. Prevents bash `[[ ... ]]` test syntax and
 * array-of-arrays literals inside fences from being matched as links (#20).
 * The closing fence must use the same character with run length >= opener.
 */
export function stripCodeFences(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of lines) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceChar === null) {
      if (open) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
        continue; // drop opening fence line
      }
      kept.push(line);
    } else {
      // inside a fence: only a matching close (same char, >= length) ends it
      if (open && open[1][0] === fenceChar && open[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      // drop all fenced lines (including the closing fence)
    }
  }
  return kept.join("\n");
}

/**
 * Strip alias ([[Title|text]]) and heading ([[Title#h]]) parts from a raw
 * wikilink target (#32).
 */
export function normalizeLinkTarget(raw: string): string {
  let target = raw.trim();
  const pipe = target.indexOf("|");
  if (pipe !== -1) target = target.slice(0, pipe);
  const hash = target.indexOf("#");
  if (hash !== -1) target = target.slice(0, hash);
  return target.trim();
}

/**
 * Resolve a wikilink target to a note node id (#32).
 * Node ids are filename basenames. Links may be authored as the exact
 * filename ([[note-two]] or Obsidian-style [[My Note]]) or as a display
 * title whose slug matches a filename ([[Note Two]] -> note-two.md).
 * Resolution order: exact basename match, then slug match. Unresolved
 * targets are keyed by their slug so dangling-link reports are stable.
 */
export function resolveLinkTarget(
  raw: string,
  titles: Set<string>,
  titleBySlug: Map<string, string>,
): string {
  const target = normalizeLinkTarget(raw);
  if (target.length === 0) return "";
  if (titles.has(target)) return target;
  const slug = slugify(target);
  return titleBySlug.get(slug) ?? slug;
}

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

  // Resolution tables: node ids are basenames; slug -> basename lets
  // display-title links ([[Note Two]]) resolve to slug files (note-two.md).
  const titles = new Set(
    markdownFiles.map((filePath) => path.basename(filePath, ".md")),
  );
  const titleBySlug = new Map<string, string>();
  for (const t of titles) {
    const slug = slugify(t);
    if (!titleBySlug.has(slug)) titleBySlug.set(slug, t);
  }

  for (const filePath of markdownFiles) {
    const title = path.basename(filePath, ".md");
    const content = await fs.readFile(filePath, "utf8");
    const { data } = parseFrontmatter(content);
    if (data?.status === "archived") {
      continue;
    }
    const links = new Set<string>();

    const linkable = stripCodeFences(content);
    for (const match of linkable.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = resolveLinkTarget(match[1] ?? "", titles, titleBySlug);
      if (target.length > 0) {
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
