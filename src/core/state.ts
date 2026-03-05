import { promises as fs } from "node:fs";
import path from "node:path";
import { getVaultPaths } from "./vault.js";

export interface OriState {
  onboarded: boolean;
  version: string;
}

const DEFAULT_STATE: OriState = {
  onboarded: false,
  version: "0.0.0",
};

function statePath(vaultDir: string): string {
  return path.join(getVaultPaths(vaultDir).marker, "state.json");
}

export async function readState(vaultDir: string): Promise<OriState> {
  try {
    const raw = await fs.readFile(statePath(vaultDir), "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function writeState(vaultDir: string, updates: Partial<OriState>): Promise<void> {
  const current = await readState(vaultDir);
  const merged = { ...current, ...updates };
  const fp = statePath(vaultDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

export function isOnboarded(state: OriState): boolean {
  return state.onboarded === true;
}
