/**
 * The CLI must learn from its own queries.
 *
 * This file exists because the defect was never a wrong algorithm - it was a
 * callsite nobody called. `useIntelligence` required an external database AND a
 * caller-supplied session id, both of which only the MCP server passed, so
 * `ori search` retrieved without ever tracking a stage, writing `stage_log`,
 * persisting a bandit policy, logging exposure, or crediting a Q-value.
 *
 * Measured consequences before this wiring:
 *   - note_q: 717 rows, 707 with update_count = 0, so q_reranking was ordering
 *     notes by the initialisation constant.
 *   - stage_log: 0 rows. Three stages sat suppressed from April to August with
 *     no trace of the decision that suppressed them.
 *   - retrieval_log missed every CLI query, so the exposure statistics that
 *     item 8 reasons over described a fraction of real usage.
 *   - The same query answered differently by transport, because only the
 *     server ran the bandit and its time budget (issue #34 section 3).
 *
 * Every assertion below is on a row count that was previously zero. A unit test
 * of the learning functions would have passed throughout the whole outage.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { runQueryRanked } from "../../src/cli/search.js";

let vault: string;

const NOTES: Array<[string, string, string]> = [
  ["agent-memory", "how agents recall context", "agents remember across sessions [[resume-j]]"],
  ["resume-j", "Resume J the document", "Resume J is a named artifact"],
  ["carbonara", "pasta recipe", "eggs guanciale pecorino"],
];

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "ori-cliwire-"));
  await fs.mkdir(path.join(vault, "notes"), { recursive: true });
  await fs.mkdir(path.join(vault, ".ori"), { recursive: true });
  for (const [name, description, body] of NOTES) {
    await fs.writeFile(
      path.join(vault, "notes", `${name}.md`),
      `---\ndescription: ${description}\ntype: insight\nstatus: active\n` +
      `access_count: 0\ncreated: 2024-01-01\n---\n\n${body}\n`,
      "utf8",
    );
  }
  await runIndexBuild(vault, true);
});

afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

function open(): InstanceType<typeof Database> {
  return new Database(path.join(vault, ".ori", "embeddings.db"), { readonly: true });
}

function count(db: InstanceType<typeof Database>, sql: string): number {
  const row = db.prepare(sql).get();
  const shaped = row as { c: number } | undefined;
  return shaped?.c ?? 0;
}

describe("a CLI query learns (fix-list items 5, 9, 10)", () => {
  it("credits Q-values through the sanctioned path", async () => {
    await runQueryRanked(vault, "agents remember memory", 2);
    const db = open();
    try {
      const tracked = count(db, "SELECT COUNT(*) c FROM note_q");
      expect(tracked, "a CLI query must produce note_q rows").toBeGreaterThan(0);
      // The number that was 10 of 717. An unlearned row is indistinguishable
      // from the initialisation constant, which is the whole of item 5.
      expect(
        count(db, "SELECT COUNT(*) c FROM note_q WHERE update_count > 0"),
        "every tracked note must have been credited, not left at init",
      ).toBe(tracked);
    } finally {
      db.close();
    }
  });

  it("records the stage decisions it made", async () => {
    await runQueryRanked(vault, "agents remember memory", 2);
    const db = open();
    try {
      expect(count(db, "SELECT COUNT(*) c FROM stage_log")).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("persists the learned bandit policy, not just the decision log", async () => {
    // stage_log and stage_q fail independently: the first records what was
    // decided, the second what was learned. Logging without saving leaves the
    // bandit unable to learn from CLI traffic while looking instrumented.
    await runQueryRanked(vault, "agents remember memory", 2);
    await runQueryRanked(vault, "Resume J", 2);
    const db = open();
    try {
      expect(count(db, "SELECT COUNT(*) c FROM stage_q")).toBeGreaterThan(0);
      const samples = count(db, "SELECT SUM(sample_count) c FROM stage_q");
      expect(samples, "two queries must advance the sample counts").toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it("logs exposure for the notes it returned", async () => {
    const result = await runQueryRanked(vault, "agents remember memory", 2);
    const returned = result.data.results.length;
    expect(returned).toBeGreaterThan(0);
    const db = open();
    try {
      expect(count(db, "SELECT COUNT(*) c FROM retrieval_log")).toBe(returned);
      expect(
        count(db, "SELECT COUNT(*) c FROM note_q WHERE exposure_count > 0"),
        "exposure is the statistic item 8 reasons over; it must count CLI usage",
      ).toBe(returned);
    } finally {
      db.close();
    }
  });

  it("reports no warnings on the happy path", async () => {
    // The fallbacks are deliberately loud: a silent degradation is the failure
    // mode this whole change removes. On a healthy vault there is nothing to
    // report, so any warning here means a path degraded without being noticed.
    const result = await runQueryRanked(vault, "agents remember memory", 2);
    expect(result.warnings).toEqual([]);
  });

  it("does not rewrite note files while answering", async () => {
    const before = await Promise.all(
      NOTES.map(([name]) => fs.readFile(path.join(vault, "notes", `${name}.md`), "utf8")),
    );
    await runQueryRanked(vault, "agents remember memory", 2);
    const after = await Promise.all(
      NOTES.map(([name]) => fs.readFile(path.join(vault, "notes", `${name}.md`), "utf8")),
    );
    expect(after, "a read must not mutate the user's vault").toEqual(before);
  });

  it("keeps the derived index covering the vault across queries", async () => {
    await runQueryRanked(vault, "agents remember memory", 2);
    const db = open();
    try {
      expect(count(db, "SELECT COUNT(*) c FROM note")).toBe(NOTES.length);
      expect(count(db, "SELECT COUNT(*) c FROM note_term")).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
