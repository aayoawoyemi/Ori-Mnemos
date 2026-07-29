/**
 * Lightweight update checker. Queries the npm registry for the latest
 * published version of ori-memory and caches the result for 24 hours.
 */
import { promises as fs } from "node:fs";
import { VERSION } from "./version.js";

import path from "node:path";
import https from "node:https";
import os from "node:os";

const PACKAGE_NAME = "ori-memory";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 3000; // don't block orient if npm is slow

// Current installed version
const CURRENT_VERSION = VERSION;

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  message: string | null;
}

interface CachedCheck {
  latest: string;
  checkedAt: number;
}

/**
 * Cache location. Deliberately NOT under ~/.ori — the ".ori" name doubles as
 * the vault marker (isVaultRoot), so a cache dir at $HOME made the walk-up
 * treat the home directory as a vault (issue #34).
 */
export function getUpdateCachePath(): string {
  const override = process.env.ORI_UPDATE_CACHE_DIR;
  if (override) return path.join(override, "ori", "update-cache.json");

  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, "ori", "update-cache.json");

  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? os.homedir();
    return path.join(base, "ori", "Cache", "update-cache.json");
  }

  return path.join(os.homedir(), ".cache", "ori", "update-cache.json");
}

function getLegacyCachePath(): string {
  return path.join(os.homedir(), ".ori", "update-cache.json");
}

export async function readCache(): Promise<CachedCheck | null> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(getUpdateCachePath(), "utf8");
  } catch {
    // New location empty — fall back to the legacy ~/.ori file (pre-0.6.1)
    try {
      raw = await fs.readFile(getLegacyCachePath(), "utf8");
    } catch {
      return null;
    }
  }
  try {
    const cached = JSON.parse(raw) as CachedCheck;
    if (Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached;
    }
  } catch {
    // Invalid cache — fetch fresh
  }
  return null;
}

export async function writeCache(latest: string): Promise<void> {
  const cachePath = getUpdateCachePath();
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({ latest, checkedAt: Date.now() }),
      "utf8",
    );
  } catch {
    // Non-critical — skip silently
  }
  // One-time migration: remove the legacy file (never the directory) so the
  // phantom-vault marker at $HOME disappears once the new cache is in place.
  try {
    await fs.unlink(getLegacyCachePath());
  } catch {
    // Already gone or inaccessible — fine
  }
}

function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);

    const req = https.get(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { headers: { Accept: "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data) as { version?: string };
            resolve(parsed.version ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function compareVersions(current: string, latest: string): boolean {
  const c = current.split(".").map(Number);
  const l = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const result: UpdateInfo = {
    current: CURRENT_VERSION,
    latest: CURRENT_VERSION,
    updateAvailable: false,
    message: null,
  };

  try {
    // Check cache first
    const cached = await readCache();
    let latest: string | null = null;

    if (cached) {
      latest = cached.latest;
    } else {
      latest = await fetchLatestVersion();
      if (latest) {
        await writeCache(latest);
      }
    }

    if (!latest) return result;

    result.latest = latest;
    result.updateAvailable = compareVersions(CURRENT_VERSION, latest);

    if (result.updateAvailable) {
      result.message =
        `Ori v${latest} available (you have v${CURRENT_VERSION}). Run: npm update -g ori-memory`;
    }
  } catch {
    // Update check is best-effort — never fail orient
  }

  return result;
}

export { CURRENT_VERSION };
