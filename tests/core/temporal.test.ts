import { describe, it, expect } from "vitest";
import { parseTemporal, classifyReminder } from "../../src/core/temporal.js";

// Blind tests — written from design v2 (wedding semantics) before implementation.
// parseTemporal(line, fallbackCapturedAt) -> { capturedAt: string|null, eventDate: string|null }
// classifyReminder(t, today) -> "upcoming" | "due" | "expired" | "note"

describe("date grammar", () => {
  it("extracts captured_at prefix (YYYY-MM-DD:)", () => {
    const t = parseTemporal("- [ ] 2026-04-06: NBA meeting today", "2026-08-01");
    expect(t.capturedAt).toBe("2026-04-06");
  });

  it("falls back to provided capturedAt when line has no date", () => {
    const t = parseTemporal("- [ ] call the bank", "2026-08-01");
    expect(t.capturedAt).toBe("2026-08-01");
  });

  it("parses explicit future event dates (on YYYY-MM-DD)", () => {
    const t = parseTemporal("- [ ] wedding on 2026-10-01", "2026-08-01");
    expect(t.eventDate).toBe("2026-10-01");
  });
});

describe("wedding-case semantics", () => {
  it("future event -> upcoming, never due-today", () => {
    const t = { capturedAt: "2026-08-01", eventDate: "2026-10-01" };
    expect(classifyReminder(t, "2026-08-15")).toBe("upcoming");
  });

  it("event day -> due", () => {
    const t = { capturedAt: "2026-08-01", eventDate: "2026-10-01" };
    expect(classifyReminder(t, "2026-10-01")).toBe("due");
  });

  it("past event -> expired, NEVER due (the NBA-meeting bug)", () => {
    const t = { capturedAt: "2026-04-06", eventDate: "2026-04-06" };
    expect(classifyReminder(t, "2026-08-01")).toBe("expired");
  });

  it("the word today is never trusted: stale line with no event date -> note", () => {
    const t = parseTemporal("- [ ] NBA meeting today", "2026-04-06");
    expect(t.eventDate).toBeNull();
    expect(classifyReminder(t, "2026-08-01")).toBe("note");
  });
});
