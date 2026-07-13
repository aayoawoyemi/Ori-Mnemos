/**
 * Single source of truth for the installed version (#24).
 * Reads package.json at runtime so the CLI, MCP server, boot state, and
 * update checker can never drift from the published npm version again.
 *
 * dist layout: dist/core/version.js -> ../../package.json
 * src layout (tests/tsx): src/core/version.ts -> ../../package.json
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

function resolvePackageJson(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // walk up from this module looking for package.json (max 4 levels)
  let dir = here;
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "package.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.name === "ori-memory" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  return null;
}

export const VERSION: string = resolvePackageJson() ?? FALLBACK_VERSION;
