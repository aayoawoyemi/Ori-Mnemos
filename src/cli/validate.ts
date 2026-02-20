import path from "node:path";
import { loadConfig, resolveTemplatePath } from "../core/config.js";
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import { validateNoteAgainstSchema } from "../core/schema.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { promises as fs } from "node:fs";

export type ValidateOptions = {
  notePath: string;
};

export async function runValidate(
  options: ValidateOptions
): Promise<{ success: boolean; errors: string[]; warnings: string[] }>
{
  const absoluteNotePath = path.resolve(options.notePath);
  const vaultRoot = await findVaultRoot(path.dirname(absoluteNotePath));
  const vaultPaths = getVaultPaths(vaultRoot);
  const config = await loadConfig(vaultPaths.config);

  const content = await fs.readFile(absoluteNotePath, "utf8");
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

  const result = await validateNoteAgainstSchema(absoluteNotePath, templatePath);
  const normalizedNotePath =
    process.platform === "win32" ? absoluteNotePath.toLowerCase() : absoluteNotePath;
  const normalizedInboxPrefix =
    (process.platform === "win32"
      ? path.resolve(vaultPaths.inbox).toLowerCase()
      : path.resolve(vaultPaths.inbox)) + path.sep;
  const isInbox = normalizedNotePath.startsWith(normalizedInboxPrefix);
  if (isInbox && result.errors.length > 0) {
    return {
      success: true,
      errors: [],
      warnings: [...result.warnings, ...result.errors],
    };
  }
  return {
    success: result.valid,
    errors: result.errors,
    warnings: result.warnings,
  };
}
