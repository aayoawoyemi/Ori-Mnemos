/**
 * `ori health` must say out loud when learning is not happening.
 *
 * `getLearningHealth` has reported `neverUpdated` since fix-list item 5, but
 * a number inside a JSON blob is not a warning. The production table this was
 * written against: 807 tracked notes, 713 never updated, all 713 of them shown
 * to an agent - retrieval running, session-end credit not. Nothing displayed
 * that until the check below existed.
 *
 * The threshold (majority of at least 50 tracked notes) is a boundary a
 * plausible edit would move, so both sides of it are pinned.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDB } from "../../src/core/engine.js";
import { initQValueTables, incrementExposure, updateQ } from "../../src/core/qvalue.js";
import { runHealth } from "../../src/cli/health.js";
import { runInit } from "../../src/cli/init.js";

let vault: string;

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "ori-health-"));
  await runInit({ targetDir: vault });
});

afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

function seedTable(tracked: number, credited: number): void {
  const db = initDB(path.join(vault, ".ori", "embeddings.db"));
  try {
    initQValueTables(db);
    for (let i = 0; i < tracked; i++) incrementExposure(db, `note-${i}`);
    for (let i = 0; i < credited; i++) updateQ(db, `note-${i}`, 0.5, "s1", "session_batch");
  } finally {
    db.close();
  }
}

async function learningWarning(): Promise<string | undefined> {
  const result = await runHealth(vault);
  return result.warnings.find((w) => w.includes("never received a Q-update"));
}

describe("ori health reports absent learning", () => {
  it("warns when most tracked notes have never been credited", async () => {
    seedTable(60, 10);
    const warning = await learningWarning();
    expect(warning).toBeDefined();
    expect(warning).toContain("50 of 60");
  });

  it("stays quiet when a majority has been credited", async () => {
    seedTable(60, 40);
    expect(await learningWarning()).toBeUndefined();
  });

  it("stays quiet on a vault too small for the ratio to mean anything", async () => {
    // A fresh vault legitimately has most notes uncredited for a while.
    seedTable(20, 0);
    expect(await learningWarning()).toBeUndefined();
  });
});
