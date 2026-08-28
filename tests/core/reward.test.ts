import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  SessionRewardAccumulator,
  EXPOSURE_BETA,
  MIN_EXPOSURE_RETENTION,
} from "../../src/core/reward.js";
import { initQValueTables, incrementExposure } from "../../src/core/qvalue.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initQValueTables(db);
});

describe("SessionRewardAccumulator", () => {
  it("hasData returns false with no retrievals", () => {
    const acc = new SessionRewardAccumulator("s1");
    expect(acc.hasData()).toBe(false);
  });

  it("hasData returns true after logging a retrieval", () => {
    const acc = new SessionRewardAccumulator("s1");
    acc.logRetrieval("note-a", 0, "query", "semantic");
    expect(acc.hasData()).toBe(true);
  });

  describe("forward citation detection", () => {
    it("gives +1.0 reward when retrieved note is cited in ori_add content", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logAdd("new-note", "This builds on [[note-a]] and extends it");

      const rewards = acc.computeRewards(db);
      expect(rewards.get("note-a")).toBeCloseTo(1.0, 10);
    });

    it("handles multiple citations", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logRetrieval("note-b", 1, "query", "semantic");
      acc.logAdd("new-note", "Combines [[note-a]] and [[note-b]]");

      const rewards = acc.computeRewards(db);
      expect(rewards.get("note-a")).toBeCloseTo(1.0, 10);
      expect(rewards.get("note-b")).toBeCloseTo(1.0, 10);
    });

    it("does not give citation reward for non-retrieved notes", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logAdd("new-note", "References [[note-x]] which was not retrieved");

      const rewards = acc.computeRewards(db);
      // note-a was retrieved but not cited, and a creation happened
      expect(rewards.has("note-a")).toBe(true);
      expect(rewards.get("note-a")!).toBeLessThan(1.0);
    });
  });

  describe("update reward", () => {
    it("gives +0.5 reward when a retrieved note is updated", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logUpdate("note-a");

      const rewards = acc.computeRewards(db);
      expect(rewards.get("note-a")).toBeCloseTo(0.5, 10);
    });
  });

  describe("downstream creation reward", () => {
    it("gives position-weighted reward when a new note is created after retrieval", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logRetrieval("note-b", 2, "query", "semantic");
      acc.logAdd("new-note", "A new insight"); // no [[citation]]

      const rewards = acc.computeRewards(db);
      // note-a at rank 0: 0.6 * (1 / log2(0+2)) = 0.6
      // note-b at rank 2: 0.6 * (1 / log2(2+2)) = 0.3
      expect(rewards.get("note-a")!).toBeGreaterThan(rewards.get("note-b")!);
    });
  });

  describe("dead end penalty", () => {
    it("gives negative reward for top-3 notes with no follow-up", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logRetrieval("note-b", 1, "query", "semantic");
      acc.logRetrieval("note-c", 3, "query", "semantic");

      const rewards = acc.computeRewards(db);
      // Top-3 (rank <= 2): note-a and note-b get penalty
      expect(rewards.get("note-a")!).toBeLessThan(0);
      expect(rewards.get("note-b")!).toBeLessThan(0);
      // Rank 3 (> 2): no penalty
      expect(rewards.get("note-c")).toBe(0);
    });

    it("applies IPS-debiased penalty (rank-weighted)", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logRetrieval("note-b", 2, "query", "semantic");

      const rewards = acc.computeRewards(db);
      // Rank 0: -0.15 / (0+1) = -0.15
      // Rank 2: -0.15 / (2+1) = -0.05
      expect(rewards.get("note-a")!).toBeCloseTo(-0.15, 10);
      expect(rewards.get("note-b")!).toBeCloseTo(-0.05, 10);
    });
  });

  describe("exposure correction", () => {
    it("diminishes reward for highly-exposed notes", () => {
      // Set exposure count to 10 for note-a
      for (let i = 0; i < 10; i++) incrementExposure(db, "note-a");

      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logAdd("new-note", "Extends [[note-a]]");

      const rewards = acc.computeRewards(db);
      // Derived from the live constants rather than a hardcoded number. This
      // test previously asserted 1.0/10^0.5 = 0.316 against a literal, so when
      // EXPOSURE_BETA moved 0.5 -> 0.25 on 2026-08-28 it failed for the right
      // reason but with a misleading message. Reading the constants means the
      // test now documents the RELATIONSHIP (reward shrinks with exposure,
      // bounded below by the retention floor), not one arithmetic result.
      const expected = Math.max(
        1 / Math.pow(10, EXPOSURE_BETA),
        MIN_EXPOSURE_RETENTION,
      );
      expect(rewards.get("note-a")!).toBeCloseTo(expected, 10);
      // Guardrail: correction must bite, but must not erase a full citation.
      expect(rewards.get("note-a")!).toBeLessThan(1.0);
      expect(rewards.get("note-a")!).toBeGreaterThanOrEqual(
        MIN_EXPOSURE_RETENTION,
      );
    });

    it("does not correct for exposure count <= 1", () => {
      incrementExposure(db, "note-a"); // exposure = 1

      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logAdd("new-note", "Extends [[note-a]]");

      const rewards = acc.computeRewards(db);
      // exposure=1, no correction applied
      expect(rewards.get("note-a")!).toBeCloseTo(1.0, 10);
    });
  });

  describe("within-session re-recall", () => {
    it("gives diminishing reward for re-retrieved notes", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query1", "semantic");
      acc.logRetrieval("note-a", 1, "query2", "semantic");
      // No follow-up, but re-recalled (ranks.length > 1)

      const rewards = acc.computeRewards(db);
      // reward = 0.4 * (1 / 2) = 0.2
      expect(rewards.get("note-a")!).toBeCloseTo(0.2, 10);
    });
  });

  describe("reward clamping", () => {
    it("clamps rewards to [-1, 1]", () => {
      const acc = new SessionRewardAccumulator("s1");
      acc.logRetrieval("note-a", 0, "query", "semantic");
      acc.logAdd("new-note", "Uses [[note-a]]");

      const rewards = acc.computeRewards(db);
      for (const reward of rewards.values()) {
        expect(reward).toBeGreaterThanOrEqual(-1);
        expect(reward).toBeLessThanOrEqual(1);
      }
    });
  });
});
