import { describe, it, expect } from "vitest";
import { LocalDecider, type Embed } from "../../src/core/decide.js";

const DIMS = 24;
const LABELS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

/**
 * A deterministic stand-in for the sentence encoder, with the one property of
 * real embeddings that matters here: ANISOTROPY. Every MiniLM vector carries a
 * large shared component, so arbitrary sentences sit at cosine ~0.3-0.6 and the
 * class-specific signal is a small perturbation on a common direction.
 *
 * Isotropic synthetic blobs hide the bug this file exists to catch: with evenly
 * spread classes, label-sorted and shuffled training score within 1 point of
 * each other. Add the shared component and the gap opens to 15.
 */
function fakeEmbed(): Embed {
  return async (text: string) => {
    const [labelPart, indexPart] = text.split("#");
    const label = LABELS.indexOf(labelPart!);
    let seed = (label + 1) * 100003 + Number(indexPart ?? 0) + 7;
    const random = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 0xffffff) / 0xffffff;
    };

    const v = new Float32Array(DIMS);
    for (let i = 0; i < DIMS; i++) v[i] = (random() - 0.5) * 1.2;
    if (label >= 0) {
      v[label]! += 1;
      v[(label + 1) % DIMS]! += 0.55;
    }
    for (let i = 0; i < DIMS; i++) v[i]! += 3.0 * Math.sin(i * 0.7 + 1);

    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIMS; i++) v[i]! /= norm;
    return v;
  };
}

/** Vault-shaped class imbalance, rarest labels last — what Object.keys yields. */
const SIZES = [102, 321, 508, 517, 21, 39];

function trainingSet(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  LABELS.forEach((label, i) => {
    out[label] = Array.from({ length: SIZES[i]! }, (_, n) => `${label}#${n}`);
  });
  return out;
}

const heldOut = LABELS.flatMap((label) =>
  Array.from({ length: 30 }, (_, n) => ({ text: `${label}#${5000 + n}`, truth: label })),
);

const CRITERIA = Object.fromEntries(LABELS.map((l) => [l, l]));
const QUESTION = { kind: "choice", criteria: CRITERIA } as const;

async function accuracy(decider: LocalDecider): Promise<{ hit: number; picked: Record<string, number> }> {
  let hit = 0;
  const picked: Record<string, number> = {};
  for (const sample of heldOut) {
    const answer = (await decider.ask(sample.text, { q: QUESTION })).q;
    picked[answer.value] = (picked[answer.value] ?? 0) + 1;
    if (answer.value === sample.truth) hit++;
  }
  return { hit: hit / heldOut.length, picked };
}

describe("LocalDecider.fit is not fooled by label-grouped training data", () => {
  // Callers assemble training data as {label: [examples]} because that is the
  // obvious shape. Feeding that stream to SGD in order let whichever label came
  // last dominate the end of every epoch. On the real 1,206-example vault set
  // it cost 19 points: 33.8% sorted, 52.6% shuffled, same data and objective.
  it("learns from data supplied grouped by label", async () => {
    const decider = new LocalDecider({ embed: fakeEmbed() });
    await decider.fit("q", trainingSet(), { epochs: 120 });
    const { hit } = await accuracy(decider);
    expect(hit).toBeGreaterThan(0.45);
  });

  it("does not collapse its predictions onto the last label", async () => {
    // The signature of the bug, and the thing accuracy alone can hide: sorted
    // training put 148 of 240 held-out predictions on the final label.
    const decider = new LocalDecider({ embed: fakeEmbed() });
    await decider.fit("q", trainingSet(), { epochs: 120 });
    const { picked } = await accuracy(decider);

    const last = picked[LABELS.at(-1)!] ?? 0;
    expect(last).toBeLessThan(heldOut.length / 3);
    // And it should be using most of the label set, not two of six.
    expect(Object.keys(picked).length).toBeGreaterThanOrEqual(4);
  });

  it("gives the same answers for two runs over the same data", async () => {
    // The shuffle is seeded. Training that moves between identical runs cannot
    // be debugged or regression-tested.
    const a = new LocalDecider({ embed: fakeEmbed() });
    const b = new LocalDecider({ embed: fakeEmbed() });
    await a.fit("q", trainingSet(), { epochs: 40 });
    await b.fit("q", trainingSet(), { epochs: 40 });
    for (const sample of heldOut.slice(0, 20)) {
      const left = (await a.ask(sample.text, { q: QUESTION })).q;
      const right = (await b.ask(sample.text, { q: QUESTION })).q;
      expect(left.value).toBe(right.value);
    }
  });
});

describe("LocalDecider reports which mode it is in", () => {
  it("beats its own unfitted prototypes once trained", async () => {
    // Unfitted prototypes scored 16.4% on the real vault against a 34.3%
    // majority-class baseline. The gap is the entire reason fit() exists, so
    // a regression that silently stops applying the head must be visible.
    const unfitted = new LocalDecider({ embed: fakeEmbed() });
    const fitted = new LocalDecider({ embed: fakeEmbed() });
    await fitted.fit("q", trainingSet(), { epochs: 120 });

    expect(unfitted.fitted()).toEqual([]);
    expect(fitted.fitted()).toEqual(["q"]);

    const before = await accuracy(unfitted);
    const after = await accuracy(fitted);
    expect(after.hit).toBeGreaterThan(before.hit);
  });

  it("only applies a head to the question it was trained for", async () => {
    const decider = new LocalDecider({ embed: fakeEmbed() });
    await decider.fit("trained", trainingSet(), { epochs: 20 });
    const answers = await decider.ask("alpha#5000", {
      trained: QUESTION,
      untrained: QUESTION,
    });
    // Same state, same label set: any difference is the head being consulted
    // for one and not the other.
    expect(answers.trained.distribution).not.toEqual(answers.untrained.distribution);
  });
});

describe("answers are usable distributions", () => {
  it("returns a full normalized distribution with the margin as confidence", async () => {
    const decider = new LocalDecider({ embed: fakeEmbed() });
    const { q } = await decider.ask("alpha#1", { q: QUESTION });

    expect(Object.keys(q.distribution).sort()).toEqual([...LABELS].sort());
    const total = Object.values(q.distribution).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);

    const ranked = Object.values(q.distribution).sort((a, b) => b - a);
    expect(q.confidence).toBeCloseTo(ranked[0]! - ranked[1]!, 10);
    expect(q.distribution[q.value]).toBe(ranked[0]);
  });

  it("scores ordinally, so an answer can sit between two levels", async () => {
    const decider = new LocalDecider({ embed: fakeEmbed() });
    const { severity } = await decider.ask("beta#3", {
      severity: { kind: "score", levels: ["calm", "annoyed", "angry", "furious"] },
    });
    expect(severity.value).toBeGreaterThanOrEqual(0);
    expect(severity.value).toBeLessThanOrEqual(1);
    expect(["calm", "annoyed", "angry", "furious"]).toContain(severity.level);
  });

  it("treats a noul as the two poles it was given", async () => {
    const decider = new LocalDecider({ embed: fakeEmbed() });
    const { urgent } = await decider.ask("gamma#2", {
      urgent: {
        kind: "noul",
        instructions: "Does this convey urgency?",
        poles: { yes: "alpha", no: "zeta" },
      },
    });
    expect(urgent.value).toBeGreaterThanOrEqual(0);
    expect(urgent.value).toBeLessThanOrEqual(1);
    expect(urgent.confidence).toBeCloseTo(Math.abs(urgent.value - 0.5) * 2, 10);
  });

  it("refuses a question it cannot answer instead of inventing a label", async () => {
    const decider = new LocalDecider({ embed: fakeEmbed() });
    await expect(decider.ask("x", { q: { kind: "choice", criteria: {} } })).rejects.toThrow(
      /no criteria/,
    );
    await expect(decider.fit("q", { only: ["one"] })).rejects.toThrow(/at least two labels/);
  });
});
