import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { loadConfig, resolveTemplatePath } from "../core/config.js";
import {
  readFrontmatterFile,
  renameWithRetry,
  writeFrontmatterFile,
} from "../core/frontmatter.js";
import { buildGraph } from "../core/graph.js";
import { validateNoteAgainstSchema } from "../core/schema.js";
import { computePromotion, isTemplatePlaceholder, type PromoteResult } from "../core/promote.js";
import type { VaultIndex } from "../core/linkdetect.js";
import type { ProjectKeywordConfig } from "../core/classify.js";
import {
  createProvider,
  NullProvider,
  type EnhancementSuggestions,
  type VaultContext,
} from "../core/llm.js";

export type PromoteOptions = {
  startDir: string;
  noteName?: string;
  all?: boolean;
  dryRun?: boolean;
  noAuto?: boolean;
  type?: string;
  description?: string;
  links?: string[];
  project?: string[];
};

export type PromotedNote = {
  from: string;
  to: string;
  changes: string[];
  warnings: string[];
  validation: { valid: boolean; errors: string[]; warnings: string[] };
};

export type PromoteCommandResult = {
  success: boolean;
  data: {
    promoted: PromotedNote[];
    skipped: Array<{ path: string; reason: string }>;
  };
  warnings: string[];
};

function getPromoteConfig(config: { promote: { project_keywords: Record<string, string[]>; project_map_routing: Record<string, string>; default_area: string; require_llm: boolean } }): {
  projectConfig: ProjectKeywordConfig;
  mapRouting: Record<string, string>;
  defaultArea: string;
  requireLlm: boolean;
} {
  return {
    projectConfig: {
      known_projects: Object.keys(config.promote.project_keywords),
      keywords: config.promote.project_keywords,
    },
    mapRouting: config.promote.project_map_routing,
    defaultArea: config.promote.default_area,
    requireLlm: config.promote.require_llm,
  };
}

async function buildVaultIndex(
  notesDir: string
): Promise<VaultIndex> {
  const titles = await listNoteTitles(notesDir);
  const graph = await buildGraph(notesDir);
  const frontmatter = new Map<string, Record<string, unknown>>();

  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    try {
      const parsed = await readFrontmatterFile(filePath);
      if (parsed.data) {
        frontmatter.set(title, parsed.data);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { titles, frontmatter, graph };
}

function buildVaultContext(vaultIndex: VaultIndex): VaultContext {
  const recentNotes = [...vaultIndex.frontmatter.entries()].slice(0, 10).map(
    ([title, data]) => ({
      title,
      type: typeof data.type === "string" ? data.type : "",
      description: typeof data.description === "string" ? data.description : "",
    }),
  );
  const projectTags = new Set<string>();
  for (const data of vaultIndex.frontmatter.values()) {
    const projects = data.project;
    if (!Array.isArray(projects)) continue;
    for (const project of projects) {
      if (typeof project === "string" && project.trim()) projectTags.add(project);
    }
  }
  return {
    existingTitles: vaultIndex.titles,
    recentNotes,
    projectTags: [...projectTags].sort(),
  };
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.md$/, "").replace(/-/g, " ");
}

function mergeEnhancementOverrides(
  options: PromoteOptions,
  suggestions: EnhancementSuggestions,
): {
  type?: string;
  description?: string;
  links?: string[];
  project?: string[];
} {
  return {
    type: options.type ?? suggestions.type,
    description: options.description ?? suggestions.description,
    links: options.links,
    project: options.project ?? suggestions.project,
  };
}

async function listInboxNotes(inboxDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(inboxDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function appendPromoteLog(
  opsDir: string,
  entry: { file: string; classification: string; confidence: string; changes: string[] }
): Promise<void> {
  const logPath = path.join(opsDir, "promote.log");
  const timestamp = new Date().toISOString();
  const line = `${timestamp} | ${entry.file} | type=${entry.classification} (${entry.confidence}) | ${entry.changes.join("; ")}\n`;
  await fs.appendFile(logPath, line, "utf8");
}

export async function runPromote(
  options: PromoteOptions
): Promise<PromoteCommandResult> {
  const vaultRoot = await findVaultRoot(options.startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const { projectConfig, mapRouting, defaultArea, requireLlm } = getPromoteConfig(config);
  const vaultIndex = await buildVaultIndex(paths.notes);
  const vaultContext = buildVaultContext(vaultIndex);
  const provider = await createProvider(config.llm);
  const hasLlm = !(provider instanceof NullProvider);

  // Resolve target inbox notes
  const allInbox = await listInboxNotes(paths.inbox);
  let targets: string[];

  if (options.all) {
    targets = allInbox;
  } else if (options.noteName) {
    // Accept with or without .md extension
    const name = options.noteName.endsWith(".md")
      ? options.noteName
      : `${options.noteName}.md`;
    if (!allInbox.includes(name)) {
      return {
        success: false,
        data: { promoted: [], skipped: [] },
        warnings: [`Inbox note not found: ${name}`],
      };
    }
    targets = [name];
  } else {
    return {
      success: false,
      data: { promoted: [], skipped: [] },
      warnings: ["Specify a note name or use --all"],
    };
  }

  const promoted: PromotedNote[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  if (requireLlm && !hasLlm) {
    return {
      success: true,
      data: {
        promoted,
        skipped: targets.map((filename) => ({
          path: path.join(paths.inbox, filename),
          reason: "LLM enhancement required but no provider is configured",
        })),
      },
      warnings: ["LLM enhancement required but no provider is configured"],
    };
  }

  for (const filename of targets) {
    const inboxPath = path.join(paths.inbox, filename);
    const parsed = await readFrontmatterFile(inboxPath);

    if (!parsed.data) {
      skipped.push({ path: inboxPath, reason: "No frontmatter found" });
      continue;
    }

    if (parsed.data.status !== "inbox") {
      skipped.push({
        path: inboxPath,
        reason: `Status is "${parsed.data.status}", not "inbox"`,
      });
      continue;
    }

    // Quality gate: reject template placeholder bodies
    if (isTemplatePlaceholder(parsed.body)) {
      skipped.push({
        path: inboxPath,
        reason:
          "Note body contains unfilled template placeholder. Add content before promoting.",
      });
      continue;
    }

    let enhancement: EnhancementSuggestions = {};
    if (hasLlm) {
      enhancement = await provider.enhance(
        {
          title: titleFromFilename(filename),
          body: parsed.body,
          frontmatter: parsed.data,
        },
        vaultContext,
      );
    }

    // Compute promotion
    const result: PromoteResult = computePromotion({
      inboxPath,
      frontmatter: parsed.data,
      body: parsed.body,
      existingTitles: vaultIndex.titles,
      vaultIndex,
      overrides: mergeEnhancementOverrides(options, enhancement),
      projectConfig,
      mapRouting,
      defaultArea,
    });

    if (enhancement.reasoning) {
      result.changes.push(`LLM reasoning: ${enhancement.reasoning}`);
    }

    const destPath = path.join(paths.notes, result.destinationFilename);

    // Collision check
    try {
      await fs.access(destPath);
      skipped.push({
        path: inboxPath,
        reason: `Note already exists at ${destPath}. Rename the inbox note or remove the existing one.`,
      });
      continue;
    } catch {
      // File doesn't exist — good
    }

    if (options.dryRun) {
      promoted.push({
        from: inboxPath,
        to: destPath,
        changes: result.changes,
        warnings: result.warnings,
        validation: { valid: true, errors: [], warnings: [] },
      });
      continue;
    }

    // Move inbox -> notes with a single rename, then rewrite the moved file in
    // place with the promoted frontmatter. A rename cannot alter content, so
    // "create the destination with the new frontmatter and drop the inbox
    // copy" is not expressible as one syscall; moving first is the ordering
    // that can neither duplicate nor lose the note. The destination is durable
    // the instant it exists, and the inbox entry is gone in the same
    // operation. Worst case after a crash between the two steps is the note
    // living in notes/ with its original inbox frontmatter - present exactly
    // once, intact, and readable.
    // renameWithRetry, not fs.rename: on Windows a rename is refused with
    // EPERM while either end is transiently open, e.g. by an antivirus filter
    // scanning the note that was just written to inbox/.
    await renameWithRetry(inboxPath, destPath);
    try {
      await writeFrontmatterFile(
        destPath,
        result.updatedFrontmatter,
        result.updatedBody
      );
    } catch (err) {
      // Roll the move back so a failed promote leaves the inbox note exactly
      // as it was. writeFrontmatterFile stages into a sibling temp file, so on
      // failure destPath still holds the untouched original bytes.
      await renameWithRetry(destPath, inboxPath).catch(() => undefined);
      throw err;
    }

    // Validate against schema
    const templatePath = resolveTemplatePath(
      config,
      vaultRoot,
      result.classification.type
    );
    let validation = { valid: true, errors: [] as string[], warnings: [] as string[] };
    try {
      validation = await validateNoteAgainstSchema(destPath, templatePath);
    } catch {
      // Template might not exist for this type
    }

    // Log promotion
    try {
      await appendPromoteLog(paths.ops, {
        file: filename,
        classification: result.classification.type,
        confidence: result.classification.confidence,
        changes: result.changes,
      });
    } catch {
      // Don't fail promotion if log write fails
    }

    promoted.push({
      from: inboxPath,
      to: destPath,
      changes: result.changes,
      warnings: result.warnings,
      validation,
    });
  }

  return {
    success: true,
    data: { promoted, skipped },
    warnings: [],
  };
}
