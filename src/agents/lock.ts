import { promises as fs } from "node:fs";
import path from "node:path";

export async function acquireLock(root: string, name = "vault") {
  const lockDir = path.join(root, `.ori-lock-${name}`);
  await fs.mkdir(lockDir, { recursive: false });
  return lockDir;
}

export async function releaseLock(lockDir: string) {
  await fs.rmdir(lockDir);
}