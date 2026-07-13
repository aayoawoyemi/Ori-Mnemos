/**
 * Ori Mnemos — Navigated Recursion MCP Integration Tests (v0.5.1)
 *
 * End-to-end over stdio: start a navigated session, steer it with each
 * direction type, hit budget, conclude. The caller is the navigator.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMcpTestContext, callTool, type McpTestContext } from "./harness.js";

let ctx: McpTestContext;

type NavData = {
  success: boolean;
  data: {
    exploration_id: string;
    budget_remaining: number;
    concluded: boolean;
    tree: Array<{
      id: string;
      kind: string;
      label: string;
      dead_end: boolean;
      new_notes: number;
      notes: Array<{ title: string }>;
    }>;
    new_notes: string[];
    frontier: Array<{ option: number; direction: Record<string, string>; reason: string }>;
  };
  warnings: string[];
};

beforeAll(async () => {
  ctx = await createMcpTestContext();

  // Fixture notes with wiki-links so the graph + frontier have structure
  await callTool(ctx.client, "ori_add", {
    title: "memory architecture decision",
    type: "decision",
    content: "We chose markdown storage. Related: [[storage tradeoffs]] and [[retrieval design]].",
  });
  await callTool(ctx.client, "ori_add", {
    title: "storage tradeoffs",
    type: "insight",
    content: "SQLite vs markdown tradeoffs. See [[memory architecture decision]].",
  });
  await callTool(ctx.client, "ori_add", {
    title: "retrieval design",
    type: "insight",
    content: "Four signal fusion design. Links to [[memory architecture decision]].",
  });
  await callTool(ctx.client, "ori_index_build", {});
}, 120000);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("navigated exploration lifecycle", () => {
  it("start returns a session with tree, frontier, and budget", async () => {
    const { parsed } = await callTool(ctx.client, "ori_explore_start", {
      query: "why markdown storage",
      budget: 3,
    });
    const res = parsed as NavData;
    expect(res.success).toBe(true);
    expect(res.data.exploration_id).toMatch(/^exp-/);
    expect(res.data.budget_remaining).toBe(3);
    expect(res.data.tree.length).toBe(1);
    expect(res.data.tree[0].kind).toBe("root");
    expect(res.data.concluded).toBe(false);
  }, 60000);

  it("expand by sub_question adds a node and consumes budget", async () => {
    const start = (await callTool(ctx.client, "ori_explore_start", {
      query: "why markdown storage",
      budget: 2,
    })).parsed as NavData;
    const id = start.data.exploration_id;

    const exp = (await callTool(ctx.client, "ori_explore_expand", {
      exploration_id: id,
      sub_question: "storage tradeoffs sqlite",
    })).parsed as NavData;

    expect(exp.success).toBe(true);
    expect(exp.data.tree.length).toBe(2);
    expect(exp.data.tree[1].kind).toBe("subQuestion");
    expect(exp.data.budget_remaining).toBe(1);
  }, 60000);

  it("expand by neighbors performs a pure graph step", async () => {
    const start = (await callTool(ctx.client, "ori_explore_start", {
      query: "retrieval design",
      budget: 2,
    })).parsed as NavData;
    const id = start.data.exploration_id;
    const anyFound = start.data.tree[0].notes[0]?.title;

    const exp = (await callTool(ctx.client, "ori_explore_expand", {
      exploration_id: id,
      neighbors: anyFound ?? "retrieval design",
    })).parsed as NavData;

    expect(exp.success).toBe(true);
    expect(exp.data.tree[1].kind).toBe("neighbors");
  }, 60000);

  it("rejects expand with no direction", async () => {
    const start = (await callTool(ctx.client, "ori_explore_start", {
      query: "why markdown storage",
    })).parsed as NavData;

    const exp = (await callTool(ctx.client, "ori_explore_expand", {
      exploration_id: start.data.exploration_id,
    })).parsed as NavData;

    expect(exp.success).toBe(false);
    expect(exp.warnings.join(" ")).toMatch(/exactly one/);
  }, 60000);

  it("rejects unknown exploration ids", async () => {
    const exp = (await callTool(ctx.client, "ori_explore_expand", {
      exploration_id: "exp-nope",
      sub_question: "anything",
    })).parsed as NavData;
    expect(exp.success).toBe(false);
    expect(exp.warnings.join(" ")).toMatch(/unknown exploration_id/);
  }, 60000);

  it("conclude closes the session and reports the summary", async () => {
    const start = (await callTool(ctx.client, "ori_explore_start", {
      query: "why markdown storage",
      budget: 2,
    })).parsed as NavData;
    const id = start.data.exploration_id;

    const done = (await callTool(ctx.client, "ori_explore_conclude", {
      exploration_id: id,
      answered: true,
      used_notes: ["memory architecture decision"],
    })).parsed as {
      success: boolean;
      data: { answered: boolean; usedNotes: string[]; totalNotes: number };
    };

    expect(done.success).toBe(true);
    expect(done.data.answered).toBe(true);
    expect(done.data.usedNotes).toEqual(["memory architecture decision"]);

    // Session is gone now
    const after = (await callTool(ctx.client, "ori_explore_expand", {
      exploration_id: id,
      sub_question: "anything else",
    })).parsed as NavData;
    expect(after.success).toBe(false);
  }, 60000);
});
