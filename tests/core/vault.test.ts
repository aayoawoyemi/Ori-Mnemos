import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isVaultRoot,
  findVaultRoot,
  findVaultRootWithSource,
  getGlobalVaultPath,
  getVaultPaths,
  listNoteTitles,
} from "../../src/core/vault.js";
import { scratchBase } from "../scratch-vault.js";

let tmpDir: string;
let fakeHome: string;
let realHomedir: typeof os.homedir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(await scratchBase(), "ori-test-vault-"));
  fakeHome = path.join(tmpDir, "fakehome");
  await fs.mkdir(fakeHome, { recursive: true });
  realHomedir = os.homedir;
  os.homedir = () => fakeHome;
});

afterEach(async () => {
  os.homedir = realHomedir;
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("isVaultRoot", () => {
  it("returns true when .ori marker exists", async () => {
    await fs.writeFile(path.join(tmpDir, ".ori"), "", "utf8");
    expect(await isVaultRoot(tmpDir)).toBe(true);
  });

  it("returns false when no .ori marker", async () => {
    expect(await isVaultRoot(tmpDir)).toBe(false);
  });
});

describe("findVaultRoot", () => {
  it("finds vault root in current directory", async () => {
    await fs.writeFile(path.join(tmpDir, ".ori"), "", "utf8");
    const root = await findVaultRoot(tmpDir);
    expect(root).toBe(path.resolve(tmpDir));
  });

  it("walks up directories to find .ori", async () => {
    await fs.writeFile(path.join(tmpDir, ".ori"), "", "utf8");
    const subDir = path.join(tmpDir, "sub", "deep");
    await fs.mkdir(subDir, { recursive: true });
    const root = await findVaultRoot(subDir);
    expect(root).toBe(path.resolve(tmpDir));
  });

  it("falls back to the global vault when one exists", async () => {
    const globalVault = getGlobalVaultPath();
    await fs.mkdir(path.join(globalVault, ".ori"), { recursive: true });

    const result = await findVaultRootWithSource(tmpDir);
    expect(result.path).toBe(path.resolve(globalVault));
    expect(result.source).toBe("global");
    await expect(findVaultRoot(tmpDir)).resolves.toBe(path.resolve(globalVault));
  });

  it("throws when neither project nor global vault exists", async () => {
    await expect(findVaultRoot(tmpDir)).rejects.toThrow("No .ori marker found");
  });
});

describe("getVaultPaths", () => {
  it("returns correct path structure", () => {
    const paths = getVaultPaths("/my/vault");
    expect(paths.root).toBe("/my/vault");
    expect(paths.marker).toBe(path.join("/my/vault", ".ori"));
    expect(paths.config).toBe(path.join("/my/vault", "ori.config.yaml"));
    expect(paths.notes).toBe(path.join("/my/vault", "notes"));
    expect(paths.inbox).toBe(path.join("/my/vault", "inbox"));
    expect(paths.templates).toBe(path.join("/my/vault", "templates"));
    expect(paths.ops).toBe(path.join("/my/vault", "ops"));
    expect(paths.opsSessions).toBe(path.join("/my/vault", "ops", "sessions"));
    expect(paths.opsObservations).toBe(
      path.join("/my/vault", "ops", "observations")
    );
  });
});

describe("listNoteTitles", () => {
  it("returns .md filenames without extension", async () => {
    const notesDir = path.join(tmpDir, "notes");
    await fs.mkdir(notesDir);
    await fs.writeFile(path.join(notesDir, "alpha.md"), "# Alpha", "utf8");
    await fs.writeFile(path.join(notesDir, "beta.md"), "# Beta", "utf8");
    const titles = await listNoteTitles(notesDir);
    expect(titles.sort()).toEqual(["alpha", "beta"]);
  });

  it("ignores non-.md files", async () => {
    const notesDir = path.join(tmpDir, "notes");
    await fs.mkdir(notesDir);
    await fs.writeFile(path.join(notesDir, "note.md"), "# Note", "utf8");
    await fs.writeFile(path.join(notesDir, "readme.txt"), "text", "utf8");
    await fs.writeFile(path.join(notesDir, "data.json"), "{}", "utf8");
    const titles = await listNoteTitles(notesDir);
    expect(titles).toEqual(["note"]);
  });

  it("returns empty array for missing directory", async () => {
    const titles = await listNoteTitles(path.join(tmpDir, "nonexistent"));
    expect(titles).toEqual([]);
  });

  it("ignores subdirectories", async () => {
    const notesDir = path.join(tmpDir, "notes");
    await fs.mkdir(notesDir);
    await fs.mkdir(path.join(notesDir, "subdir.md"));
    await fs.writeFile(path.join(notesDir, "real.md"), "# Real", "utf8");
    const titles = await listNoteTitles(notesDir);
    expect(titles).toEqual(["real"]);
  });
});
