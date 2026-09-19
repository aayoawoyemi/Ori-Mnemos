import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findVaultRoot,
  findVaultRootWithSource,
  getGlobalVaultPath,
  isVaultRoot,
} from "../../src/core/vault.js";
import { runInit } from "../../src/cli/init.js";
import { scratchBase } from "../scratch-vault.js";

let tmpDir: string;
let fakeHome: string;
let realHomedir: typeof os.homedir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(await scratchBase(), "ori-autoinit-"));
  fakeHome = path.join(tmpDir, "fakehome");
  await fs.mkdir(fakeHome, { recursive: true });

  // Mock os.homedir to isolate tests from real home directory
  realHomedir = os.homedir;
  os.homedir = () => fakeHome;
});

afterEach(async () => {
  os.homedir = realHomedir;
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getGlobalVaultPath", () => {
  it("returns ~/.ori-memory", () => {
    expect(getGlobalVaultPath()).toBe(path.join(fakeHome, ".ori-memory"));
  });
});

describe("findVaultRoot — global fallback", () => {
  it("throws when no vault anywhere and no global vault", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });
    await expect(findVaultRoot(noVaultDir)).rejects.toThrow("No .ori marker found");
  });

  it("returns project vault when it exists", async () => {
    const projectDir = path.join(tmpDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".ori"), { recursive: true });
    const root = await findVaultRoot(projectDir);
    expect(root).toBe(path.resolve(projectDir));
  });

  it("returns global vault when no project vault exists", async () => {
    // Create global vault at fakeHome/.ori-memory/
    const globalPath = path.join(fakeHome, ".ori-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".ori"), { recursive: true });

    // Search from a directory with no vault
    const noVaultDir = path.join(tmpDir, "novault");
    await fs.mkdir(noVaultDir, { recursive: true });
    const root = await findVaultRoot(noVaultDir);
    expect(root).toBe(path.resolve(globalPath));
  });

  it("project vault wins over global vault", async () => {
    // Create global vault
    const globalPath = path.join(fakeHome, ".ori-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".ori"), { recursive: true });

    // Create project vault
    const projectDir = path.join(tmpDir, "myproject");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".ori"), { recursive: true });

    const root = await findVaultRoot(projectDir);
    expect(root).toBe(path.resolve(projectDir));
  });
});

describe("findVaultRootWithSource", () => {
  it("returns source: project for project vault", async () => {
    const projectDir = path.join(tmpDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".ori"), { recursive: true });

    const result = await findVaultRootWithSource(projectDir);
    expect(result.source).toBe("project");
    expect(result.path).toBe(path.resolve(projectDir));
  });

  it("returns source: global for global vault", async () => {
    const globalPath = path.join(fakeHome, ".ori-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".ori"), { recursive: true });

    const noVaultDir = path.join(tmpDir, "novault");
    await fs.mkdir(noVaultDir, { recursive: true });

    const result = await findVaultRootWithSource(noVaultDir);
    expect(result.source).toBe("global");
    expect(result.path).toBe(path.resolve(globalPath));
  });

  it("throws with clear message when --vault points to nonexistent path", async () => {
    const badPath = path.join(tmpDir, "nonexistent");
    await expect(findVaultRootWithSource(tmpDir, badPath)).rejects.toThrow(
      "Vault not found at specified path",
    );
  });

  it("--vault override never falls back to global", async () => {
    // Create global vault
    const globalPath = path.join(fakeHome, ".ori-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".ori"), { recursive: true });

    // Override points to non-vault — should throw, NOT fall back to global
    const badOverride = path.join(tmpDir, "badoverride");
    await fs.mkdir(badOverride, { recursive: true });
    await expect(findVaultRootWithSource(tmpDir, badOverride)).rejects.toThrow(
      "Vault not found at specified path",
    );
  });
});

describe("serve auto-create simulation", () => {
  // Simulates what serve.ts does: try findVaultRootWithSource, on failure auto-create

  async function serveAutoCreate(startDir: string, vaultOverride?: string) {
    let autoCreated = false;
    let vaultRoot: string;

    try {
      const result = await findVaultRootWithSource(startDir, vaultOverride);
      vaultRoot = result.path;
    } catch (err) {
      if (vaultOverride) throw err;
      const globalPath = getGlobalVaultPath();
      await runInit({ targetDir: globalPath });
      vaultRoot = globalPath;
      autoCreated = true;
    }

    return { vaultRoot, autoCreated };
  }

  it("auto-creates global vault when no vault exists", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });

    const result = await serveAutoCreate(noVaultDir);
    expect(result.autoCreated).toBe(true);
    expect(result.vaultRoot).toBe(path.join(fakeHome, ".ori-memory"));

    // Verify scaffold was created
    expect(await isVaultRoot(result.vaultRoot)).toBe(true);
    const identityPath = path.join(result.vaultRoot, "self", "identity.md");
    const identity = await fs.readFile(identityPath, "utf8");
    expect(identity).toContain("<!-- First session:");
  });

  it("auto-created vault triggers isFirstRun", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });

    const result = await serveAutoCreate(noVaultDir);
    const identityPath = path.join(result.vaultRoot, "self", "identity.md");
    const identity = await fs.readFile(identityPath, "utf8");

    // isFirstRun checks: strip frontmatter, check for scaffold marker or empty content
    expect(identity).toContain("<!-- First session:");
  });

  it("--vault /nonexistent throws, does NOT auto-create", async () => {
    const badPath = path.join(tmpDir, "bad");
    await expect(serveAutoCreate(tmpDir, badPath)).rejects.toThrow(
      "Vault not found at specified path",
    );

    // Global vault should NOT have been created
    const globalPath = path.join(fakeHome, ".ori-memory");
    expect(await isVaultRoot(globalPath)).toBe(false);
  });

  it("second call after auto-create returns existing vault, autoCreated false", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });

    // First call — auto-creates
    const first = await serveAutoCreate(noVaultDir);
    expect(first.autoCreated).toBe(true);

    // Second call — finds existing global vault via findVaultRootWithSource
    const second = await serveAutoCreate(noVaultDir);
    expect(second.autoCreated).toBe(false);
    expect(second.vaultRoot).toBe(first.vaultRoot);
  });
});
