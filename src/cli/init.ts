import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVaultPaths } from "../core/vault.js";

export type InitOptions = {
  targetDir: string;
};

export type InitResult = {
  created: string[];
  skipped: string[];
};

async function copyDir(src: string, dest: string, result: InitResult): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, result);
    } else {
      try {
        await fs.access(destPath);
        result.skipped.push(destPath);
      } catch {
        await fs.copyFile(srcPath, destPath);
        result.created.push(destPath);
      }
    }
  }
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const target = path.resolve(options.targetDir);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const scaffoldRoot = path.resolve(__dirname, "..", "..", "scaffold");
  const result: InitResult = { created: [], skipped: [] };

  await copyDir(scaffoldRoot, target, result);

  // Ensure top-level marker exists
  const paths = getVaultPaths(target);
  try {
    await fs.access(paths.marker);
  } catch {
    await fs.writeFile(paths.marker, "");
    result.created.push(paths.marker);
  }

  return result;
}
