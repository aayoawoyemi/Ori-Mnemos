import { describe, it, expect } from "vitest";
import { classifyIntent, getSpaceWeights, getSplitWeights } from "../../src/core/intent.js";

describe("classifyIntent", () => {
  it("classifies 'when did' queries as episodic", () => {
    const result = classifyIntent("when did we discuss token economics");
    expect(result.intent).toBe("episodic");
  });

  it("classifies 'how to' queries as procedural", () => {
    const result = classifyIntent("how to set up the deployment pipeline");
    expect(result.intent).toBe("procedural");
  });

  it("classifies 'why did we decide' queries as decision", () => {
    const result = classifyIntent("why did we decide to use PostgreSQL");
    expect(result.intent).toBe("decision");
  });

  it("defaults to semantic for generic queries", () => {
    const result = classifyIntent("agent memory architecture");
    expect(result.intent).toBe("semantic");
  });

  it("extracts entities from note index", () => {
    const noteIndex = ["agent memory architecture", "token economics", "short"];
    const result = classifyIntent("tell me about agent memory architecture", noteIndex);
    expect(result.entities).toContain("agent memory architecture");
    // "short" is only 5 chars but >= 3, and appears in query? No it doesn't.
    expect(result.entities).not.toContain("short");
  });

  it("returns space weights matching intent", () => {
    const result = classifyIntent("when did we last deploy");
    expect(result.spaceWeights.temporal).toBe(0.25);
    expect(result.spaceWeights.text).toBe(0.40);
  });

  it("returns split weights matching intent", () => {
    const result = classifyIntent("what happened with the crypto launch");
    expect(result.splitWeights.body).toBe(0.6); // episodic
  });

  it("higher confidence for multiple pattern matches", () => {
    const single = classifyIntent("recently something happened");
    const multi = classifyIntent("when did this happen recently, last time I checked");
    expect(multi.confidence).toBeGreaterThanOrEqual(single.confidence);
  });
});

describe("getSpaceWeights", () => {
  it("returns weights that sum to 1.0", () => {
    for (const intent of ["episodic", "procedural", "semantic", "decision"] as const) {
      const w = getSpaceWeights(intent);
      const sum = w.text + w.temporal + w.vitality + w.importance + w.type + w.community;
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });
});

describe("getSplitWeights", () => {
  it("returns weights that sum to 1.0", () => {
    for (const intent of ["episodic", "procedural", "semantic", "decision"] as const) {
      const w = getSplitWeights(intent);
      const sum = w.title + w.description + w.body;
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });
});
