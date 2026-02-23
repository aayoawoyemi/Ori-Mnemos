import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import { loadConfig, resolveTemplatePath } from "../core/config.js";
import { parseFrontmatter, stringifyFrontmatter } from "../core/frontmatter.js";
import { runValidate } from "./validate.js";
import { runPromote } from "./promote.js";

export type AddOptions = {
  startDir: string;
  title: string;
  type?: string;
};

export type AddResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export async function runAdd(options: AddOptions): Promise<AddResult> {
  const vaultRoot = await findVaultRoot(options.startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  const type = options.type ?? "insight";
  const templatePath = resolveTemplatePath(config, vaultRoot, type);
  const templateContent = await fs.readFile(templatePath, "utf8");
  const templateParsed = parseFrontmatter(templateContent);
  const templateBody = templateParsed.body;

  const now = new Date();
  const created = now.toISOString().slice(0, 10);

  const frontmatter = {
    description: "",
    type,
    project: [],
    status: "inbox",
    created,
    last_accessed: created,
    access_count: 0,
  };

  const titleLine = `# ${options.title}`;
  const body = templateBody.replace(/# \{[^}]+\}/, titleLine);

  const content = stringifyFrontmatter(frontmatter, body);
  const rawSlug = slugify(options.title);
  const baseSlug = rawSlug || `note-${Date.now()}`;
  let filename = `${baseSlug}.md`;
  let destPath = path.join(paths.inbox, filename);
  let counter = 2;
  while (true) {
    try {
      await fs.access(destPath);
      filename = `${baseSlug}-${counter}.md`;
      destPath = path.join(paths.inbox, filename);
      counter++;
    } catch {
      break;
    }
  }

  await fs.writeFile(destPath, content, "utf8");

  const validation = await runValidate({ notePath: destPath });
  const warnings = [...validation.warnings];
  if (!frontmatter.description) {
    warnings.push("Description is empty");
  }

  // Auto-ingest: promote immediately if config.promote.auto is true
  const autoPromote = config.promote?.auto ?? false;

  if (autoPromote) {
    try {
      const promoteResult = await runPromote({
        startDir: options.startDir,
        noteName: filename,
      });
      if (promoteResult.success && promoteResult.data.promoted.length > 0) {
        const promoted = promoteResult.data.promoted[0];
        warnings.push(
          ...promoted.warnings,
          ...promoted.changes.map((c) => `auto-promote: ${c}`)
        );
        return {
          success: true,
          data: { path: promoted.to, autoPromoted: true },
          warnings,
        };
      }
    } catch {
      warnings.push("Auto-promote failed, note remains in inbox");
    }
  }

  return {
    success: true,
    data: { path: destPath },
    warnings,
  };
}
