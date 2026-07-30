import { describe, it, expect } from "vitest";
import { buildWakePayload, coverDaily } from "../../src/core/wake.js";

// Blind contract tests — written from docs/wake-nap-design.md BEFORE implementation.
// Contract: buildWakePayload(inputs, budgetLines) -> { lines: string[], sections: Record<string, number> }
// Contract: coverDaily(entries, alpha) -> array of {lines, daysOld ...} obeying size <= alpha * age.

function fakeInputs(overrides: Partial<Record<string, string>> = {}) {
  return {
    identity: "# identity\nName: TestBot. A test agent.\n" + "filler\n".repeat(200),
    goals: "# goals\n" + Array.from({ length: 40 }, (_, i) => `- goal ${i}`).join("\n"),
    reminders: "# reminders\n- [ ] due today: pay bill\n- [ ] someday: read book\n" + "- [ ] junk\n".repeat(80),
    daily: Array.from({ length: 120 }, (_, i) => `## 2026-0${(i % 6) + 1}-15\nentry ${i} line a\nentry ${i} line b`).join("\n"),
    warmNotes: Array.from({ length: 50 }, (_, i) => ({ title: `note-${i}`, decayed: 1 - i * 0.01 })),
    vaultStats: { noteCount: 5000, inboxCount: 37, zones: { active: 10, stale: 20, fading: 5, archived: 100 } },
    notices: [],
    ...overrides,
  };
}

describe("wake budget contract", () => {
  it("NEVER exceeds the budget, even with adversarially huge inputs", () => {
    for (const budget of [96, 40, 200]) {
      const out = buildWakePayload(fakeInputs() as never, budget);
      expect(out.lines.length).toBeLessThanOrEqual(budget);
    }
  });

  it("is deterministic: same inputs -> identical output", () => {
    const a = buildWakePayload(fakeInputs() as never, 96);
    const b = buildWakePayload(fakeInputs() as never, 96);
    expect(a.lines).toEqual(b.lines);
  });

  it("identity survives even at tiny budgets; low-priority sections drop first", () => {
    const out = buildWakePayload(fakeInputs() as never, 10);
    const joined = out.lines.join("\n");
    expect(joined).toContain("TestBot");
    // vault vitals (priority 7) must be gone before goals (priority 2) at tiny budget
    expect(out.sections["vault_vitals"] ?? 0).toBe(0);
    expect(out.sections["active_goals"] ?? 0).toBeGreaterThan(0);
  });

  it("goals capped at its share (<=8 lines) despite 40 goal bullets", () => {
    const out = buildWakePayload(fakeInputs() as never, 96);
    expect(out.sections["active_goals"]).toBeLessThanOrEqual(8);
  });

  it("empty vault: small clean payload, no crash", () => {
    const out = buildWakePayload(fakeInputs({ identity: "", goals: "", reminders: "", daily: "" }) as never, 96);
    expect(out.lines.length).toBeGreaterThan(0);
    expect(out.lines.length).toBeLessThanOrEqual(96);
  });
});

describe("temporal fovea (coverDaily)", () => {
  const mkEntries = (n: number) => Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
    lines: [`entry ${i} a`, `entry ${i} b`, `entry ${i} c`],
  }));

  it("today stays raw; old entries compress", () => {
    const cover = coverDaily(mkEntries(60), 2);
    const today = cover[0];
    expect(today.lines.length).toBe(3); // raw
    const oldest = cover[cover.length - 1];
    expect(oldest.lines.length).toBeLessThan(3); // compressed
  });

  it("total output grows sublinearly: 4x entries < 2x lines", () => {
    const lines = (n: number) => coverDaily(mkEntries(n), 2).reduce((s, b) => s + b.lines.length, 0);
    expect(lines(120)).toBeLessThan(lines(30) * 2);
  });
});
