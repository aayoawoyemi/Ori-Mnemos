/**
 * Ori Mnemos — Manual Steering CLI Tests (v0.5.1)
 *
 * File-backed navigated sessions: explore-start persists to
 * .ori/explore-sessions/, explore-expand resumes across invocations
 * (fresh deps each time, like real CLI calls), conclude validates and
 * removes the session file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import {
  runExploreStartCli,
  runExploreExpandCli,
  runExploreConcludeCli,
} from "../../src/cli/explore.js";

let vaultDir: string;

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-cli-steer-"));
  await runInit({ targetDir: vaultDir });
  const notes: Array<[string, string, string]> = [
    ["court coin origin", "decision", "Started as [[courtshare pivot]]. NBA player stock market."],
    ["courtshare pivot", "decision", "Pivoted after [[rental model failure]]. See [[kalshi inspiration]]."],
    ["rental model failure", "insight", "Bookings never hit volume. Led to [[courtshare pivot]]."],
    ["kalshi inspiration", "insight", "Regulated event markets work. Motivated [[court coin origin]]."],
    ["bench press log", "insight", "Gym distractor."],
  ];
  for (const [title, type, content] of notes) {
    await runAdd({ startDir: vaultDir, title, type, content });
  }
  await runIndexBuild(vaultDir);
}, 120000);

afterAll(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("manual steering via file-backed sessions", () => {
  it("start persists a session file under .ori/explore-sessions/", async () => {
    const r = await runExploreStartCli(vaultDir, "why did we start court coin", 3);
    expect(r.success).toBe(true);
    const id = (r.data as { exploration_id: string }).exploration_id;
    const file = path.join(vaultDir, ".ori", "explore-sessions", `${id}.json`);
    await expect(fs.access(file)).resolves.toBeUndefined();
  }, 60000);

  it("expand resumes from disk in a separate invocation and persists the step", async () => {
    const start = await runExploreStartCli(vaultDir, "why did we start court coin", 3);
    const id = (start.data as { exploration_id: string }).exploration_id;

    // Separate invocation: fresh deps built from disk, session loaded from file
    const exp = await runExploreExpandCli(vaultDir, id, { neighbors: "courtshare-pivot" });
    expect(exp.success).toBe(true);
    const data = exp.data as { tree: unknown[]; budget_remaining: number };
    expect(data.tree.length).toBe(2);
    expect(data.budget_remaining).toBe(2);

    // And the persisted state reflects it
    const raw = await fs.readFile(
      path.join(vaultDir, ".ori", "explore-sessions", `${id}.json`), "utf8");
    const state = JSON.parse(raw) as { nodes: unknown[]; budgetRemaining: number };
    expect(state.nodes.length).toBe(2);
    expect(state.budgetRemaining).toBe(2);
  }, 60000);

  it("conclude validates usedNotes (display-title tolerant) and deletes the file", async () => {
    const start = await runExploreStartCli(vaultDir, "why did we start court coin", 3);
    const id = (start.data as { exploration_id: string }).exploration_id;

    const done = await runExploreConcludeCli(vaultDir, id, {
      answered: true,
      usedNotes: ["Court Coin Origin", "phantom-note"],
    });
    expect(done.success).toBe(true);
    const summary = done.data as { usedNotes: string[]; rejectedNotes: string[] };
    expect(summary.usedNotes).toEqual(["court-coin-origin"]);
    expect(summary.rejectedNotes).toEqual(["phantom-note"]);

    const file = path.join(vaultDir, ".ori", "explore-sessions", `${id}.json`);
    await expect(fs.access(file)).rejects.toThrow();

    // Expanding a concluded (deleted) session fails cleanly
    const after = await runExploreExpandCli(vaultDir, id, { subQuestion: "anything" });
    expect(after.success).toBe(false);
    expect(after.warnings.join(" ")).toMatch(/unknown exploration_id/);
  }, 60000);

  it("unknown ids fail with a helpful message", async () => {
    const r = await runExploreExpandCli(vaultDir, "exp-nope", { subQuestion: "x" });
    expect(r.success).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/explore-sessions/);
  }, 60000);
});
