/**
 * Lightweight update checker. Queries the npm registry for the latest
 * published version of ori-memory and caches the result for 24 hours.
 */
import { promises as fs } from "node:fs";
import { VERSION } from "./version.js";

import path from "node:path";
import https from "node:https";

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

function getCachePath(): string {
  const home =
    process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return path.join(home, ".ori", "update-cache.json");
}

async function readCache(): Promise<CachedCheck | null> {
  try {
    const raw = await fs.readFile(getCachePath(), "utf8");
    const cached = JSON.parse(raw) as CachedCheck;
    if (Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached;
    }
  } catch {
    // No cache or invalid — fetch fresh
  }
  return null;
}

async function writeCache(latest: string): Promise<void> {
  const cachePath = getCachePath();
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

function compareVersions(current: string, latest: string): boolean {
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
