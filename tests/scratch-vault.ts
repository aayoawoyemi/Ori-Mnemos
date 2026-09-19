import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isVaultRoot } from "../src/core/vault.js";

// Vault discovery walks upward until it finds a `.ori` marker. Tests that
// assert what happens when there is *no* vault therefore need a scratch
// directory with no vault anywhere above it — otherwise the walk escapes into
// whatever the machine happens to have and the negative cases silently stop
// testing anything.
//
// The filesystem root satisfies that on Windows, where os.tmpdir() lives under
// the developer's home directory and the walk can reach their real vault. On
// Linux the root is not writable: `EACCES: mkdtemp '/ori-autoinit-...'`, which
// failed 13 tests on every ubuntu runner while passing on the author's
// machine. Two test files had their own copy of the assumption.
//
// So the base is chosen by checking both properties instead of hard-coding a
// platform, and the result is memoised because the probe touches the disk.

let cached: string | null = null;

async function hasVaultAncestor(dir: string): Promise<boolean> {
  let current = path.resolve(dir);
  for (;;) {
    if (await isVaultRoot(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function scratchBase(): Promise<string> {
  if (cached) return cached;

  const candidates = [os.tmpdir(), path.parse(os.tmpdir()).root];
  for (const candidate of candidates) {
    let probe: string | null = null;
    try {
      probe = await fs.mkdtemp(path.join(candidate, "ori-probe-"));
      if (!(await hasVaultAncestor(candidate))) {
        cached = candidate;
        return cached;
      }
    } catch {
      // Not writable by this user. Try the next candidate.
    } finally {
      if (probe) await fs.rm(probe, { recursive: true, force: true });
    }
  }

  throw new Error(
    `no writable scratch directory without a .ori ancestor (tried ${candidates.join(", ")})`,
  );
}
