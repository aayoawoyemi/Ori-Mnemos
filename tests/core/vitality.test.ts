import { describe, it, expect } from "vitest";
import { daysBetween, computeVitality, computeVitalityACTR, computeStructuralBoost, computeRevivalBoost, computeAccessSaturation, computeVitalityFull, classifyZone } from "../../src/core/vitality.js";

describe("daysBetween", () => {
  it("returns 0 for same date", () => {
    const d = new Date("2026-01-15");
    expect(daysBetween(d, d)).toBe(0);
  });

  it("returns correct days for dates 30 apart", () => {
    const a = new Date("2026-01-01");
    const b = new Date("2026-01-31");
    expect(daysBetween(a, b)).toBe(30);
  });

  it("returns positive value regardless of order", () => {
    const a = new Date("2026-03-01");
    const b = new Date("2026-01-01");
    expect(daysBetween(a, b)).toBeGreaterThan(0);
    expect(daysBetween(a, b)).toBe(daysBetween(b, a));
  });

  it("handles fractional days", () => {
    const a = new Date("2026-01-01T00:00:00Z");
    const b = new Date("2026-01-01T12:00:00Z");
    expect(daysBetween(a, b)).toBeCloseTo(0.5, 1);
  });
});

describe("computeVitality", () => {
  it("returns base when lastAccessed equals now", () => {
    const now = new Date("2026-02-01");
    const v = computeVitality({ base: 1.0, decayDays: 30 }, now, now);
    expect(v).toBe(1.0);
  });

  it("decays exponentially over time", () => {
    const now = new Date("2026-03-03");
    const accessed = new Date("2026-02-01"); // 30 days ago
    const v = computeVitality({ base: 1.0, decayDays: 30 }, accessed, now);
    // e^(-1) ≈ 0.368
    expect(v).toBeCloseTo(Math.exp(-1), 2);
  });

  it("returns base when decayDays is 0", () => {
    const now = new Date("2026-06-01");
    const accessed = new Date("2026-01-01"); // 151 days ago
    const v = computeVitality({ base: 1.0, decayDays: 0 }, accessed, now);
    expect(v).toBe(1.0);
  });

  it("returns base when decayDays is negative", () => {
    const now = new Date("2026-06-01");
    const accessed = new Date("2026-01-01");
    const v = computeVitality({ base: 1.0, decayDays: -10 }, accessed, now);
    expect(v).toBe(1.0);
  });

  it("clamps result to [0, base]", () => {
    const now = new Date("2026-01-01");
    const accessed = new Date("2016-01-01"); // 10 years ago
    const v = computeVitality({ base: 1.0, decayDays: 30 }, accessed, now);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1.0);
  });

  it("respects custom base value", () => {
    const now = new Date("2026-02-01");
    const v = computeVitality({ base: 5.0, decayDays: 30 }, now, now);
    expect(v).toBe(5.0);
  });

  it("decays faster with shorter decayDays", () => {
    const now = new Date("2026-03-03");
    const accessed = new Date("2026-02-01"); // 30 days
    const slow = computeVitality({ base: 1.0, decayDays: 90 }, accessed, now);
    const fast = computeVitality({ base: 1.0, decayDays: 14 }, accessed, now);
    expect(fast).toBeLessThan(slow);
  });

  it("approaches zero for very old notes", () => {
    const now = new Date("2026-01-01");
    const accessed = new Date("2020-01-01"); // ~2190 days
    const v = computeVitality({ base: 1.0, decayDays: 30 }, accessed, now);
    expect(v).toBeLessThan(0.001);
  });
});

describe("computeVitalityACTR", () => {
  it("returns 0.5 for zero access count (cold start)", () => {
    expect(computeVitalityACTR(0, 30)).toBe(0.5);
  });

  it("returns 1.0 for zero lifetime (brand new)", () => {
    expect(computeVitalityACTR(5, 0)).toBe(1.0);
  });

  it("returns value between 0 and 1", () => {
    const v = computeVitalityACTR(10, 30);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("higher access count increases vitality", () => {
    const low = computeVitalityACTR(2, 30);
    const high = computeVitalityACTR(20, 30);
    expect(high).toBeGreaterThan(low);
  });

  it("longer lifetime decreases vitality (more decay)", () => {
    const young = computeVitalityACTR(5, 7);
    const old = computeVitalityACTR(5, 365);
    expect(young).toBeGreaterThan(old);
  });
});

describe("computeStructuralBoost", () => {
  it("returns 1.0 for zero in-degree", () => {
    expect(computeStructuralBoost(0)).toBe(1.0);
  });

  it("returns 2.0 for 10+ in-degree (capped)", () => {
    expect(computeStructuralBoost(10)).toBe(2.0);
    expect(computeStructuralBoost(100)).toBe(2.0);
  });

  it("returns 1.5 for 5 in-degree", () => {
    expect(computeStructuralBoost(5)).toBe(1.5);
  });
});

describe("computeRevivalBoost", () => {
  it("returns 0 for undefined", () => {
    expect(computeRevivalBoost(undefined)).toBe(0);
  });

  it("returns ~1.0 for brand new connection (day 0)", () => {
    expect(computeRevivalBoost(0)).toBeCloseTo(1.0, 2);
  });

  it("returns 0 after 14 days", () => {
    expect(computeRevivalBoost(14)).toBe(0);
    expect(computeRevivalBoost(30)).toBe(0);
  });

  it("decays over time", () => {
    const day1 = computeRevivalBoost(1);
    const day7 = computeRevivalBoost(7);
    expect(day1).toBeGreaterThan(day7);
  });
});

describe("computeAccessSaturation", () => {
  it("returns 0 for zero accesses", () => {
    expect(computeAccessSaturation(0)).toBe(0);
  });

  it("returns ~0.63 for 10 accesses (1 - 1/e)", () => {
    expect(computeAccessSaturation(10)).toBeCloseTo(1 - Math.exp(-1), 2);
  });

  it("approaches 1 for many accesses", () => {
    expect(computeAccessSaturation(100)).toBeGreaterThan(0.99);
  });
});

describe("computeVitalityFull", () => {
  it("returns value between 0 and 1", () => {
    const v = computeVitalityFull({
      accessCount: 5,
      created: "2026-01-01",
      noteTitle: "test note",
      inDegree: 3,
      bridges: new Set(),
    });
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("bridge notes never go below floor", () => {
    const v = computeVitalityFull({
      accessCount: 0,
      created: "2020-01-01", // very old
      noteTitle: "important bridge",
      inDegree: 0,
      bridges: new Set(["important bridge"]),
      bridgeFloor: 0.5,
    });
    expect(v).toBeGreaterThanOrEqual(0.5);
  });

  it("higher metabolic rate means faster decay", () => {
    const base = {
      accessCount: 5,
      created: "2025-01-01",
      noteTitle: "test",
      inDegree: 2,
      bridges: new Set<string>(),
    };
    const slow = computeVitalityFull({ ...base, metabolicRate: 0.1 });
    const fast = computeVitalityFull({ ...base, metabolicRate: 3.0 });
    expect(slow).toBeGreaterThan(fast);
  });

  it("revival spike boosts vitality", () => {
    const base = {
      accessCount: 3,
      created: "2025-06-01",
      noteTitle: "revived",
      inDegree: 1,
      bridges: new Set<string>(),
    };
    const noRevival = computeVitalityFull(base);
    const withRevival = computeVitalityFull({ ...base, daysSinceNewConnection: 0 });
    expect(withRevival).toBeGreaterThan(noRevival);
  });
});

describe("classifyZone", () => {
  it("classifies high vitality as active", () => {
    expect(classifyZone(0.8)).toBe("active");
  });

  it("classifies mid vitality as stale", () => {
    expect(classifyZone(0.45)).toBe("stale");
  });

  it("classifies low vitality as fading", () => {
    expect(classifyZone(0.15)).toBe("fading");
  });

  it("classifies very low vitality as archived zone", () => {
    expect(classifyZone(0.05)).toBe("archived");
  });

  it("status archived overrides high vitality", () => {
    expect(classifyZone(0.95, "archived")).toBe("archived");
  });

  it("boundary: 0.6 is active (>= not >)", () => {
    expect(classifyZone(0.6)).toBe("active");
  });

  it("boundary: 0.3 is stale", () => {
    expect(classifyZone(0.3)).toBe("stale");
  });

  it("boundary: 0.1 is fading", () => {
    expect(classifyZone(0.1)).toBe("fading");
  });

  it("boundary: just below 0.1 is archived zone", () => {
    expect(classifyZone(0.09999)).toBe("archived");
  });

  it("respects custom thresholds", () => {
    const custom = { active: 0.8, stale: 0.5, fading: 0.2 };
    expect(classifyZone(0.7, undefined, custom)).toBe("stale");
    expect(classifyZone(0.5, undefined, custom)).toBe("stale");
    expect(classifyZone(0.3, undefined, custom)).toBe("fading");
    expect(classifyZone(0.1, undefined, custom)).toBe("archived");
    expect(classifyZone(0.8, undefined, custom)).toBe("active");
  });

  it("zero vitality is archived zone", () => {
    expect(classifyZone(0)).toBe("archived");
  });

  it("non-archived status does not override zone", () => {
    expect(classifyZone(0.05, "active")).toBe("archived");
    expect(classifyZone(0.8, "stale")).toBe("active");
  });
});
