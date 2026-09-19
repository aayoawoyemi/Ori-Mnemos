/**
 * Typed decisions: questions in, calibrated distributions out.
 *
 * Ori makes a lot of closed-set decisions — which retrieval stage to run, what
 * type a note is, whether a term is an identifier — and every one of them is
 * currently a hand-ordered regex list or a bandit learning from a reward it
 * cannot see. Those are all the same object: a probability distribution over a
 * known label set. This module names that object so the decisions stop being
 * bespoke.
 *
 * The interface is deliberately the shape TypeSafe's System One models expose
 * (Noul / Choice / Score), because that shape is not proprietary — a calibrated
 * distribution over a closed label set is what a softmax is. Naming it this way
 * means a hosted decision model can be dropped in later as a second backend
 * without touching a caller.
 *
 * The DEFAULT backend is local, offline and free, and must stay that way:
 * `ori query` works on a plane, and that promise is load-bearing.
 */

/** A yes/no question. Both poles are described, because a local backend has to
 *  compare the state against something; "the absence of the instruction" is not
 *  a thing you can embed. A hosted backend collapses this to `instructions`. */
export interface NoulQuestion {
  kind: "noul";
  instructions: string;
  /** What a yes looks like, and what a no looks like. */
  poles: { yes: string; no: string };
}

/** Pick exactly one label. `criteria` maps label -> what that label means. */
export interface ChoiceQuestion {
  kind: "choice";
  criteria: Record<string, string>;
}

/** Rate against ORDERED levels, lowest first. */
export interface ScoreQuestion {
  kind: "score";
  levels: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  kind: "noul";
  /** P(yes). */
  value: number;
  confidence: number;
}

export interface ChoiceAnswer {
  kind: "choice";
  /** Highest-probability label. */
  value: string;
  /** Full distribution, every label present, sums to 1. */
  distribution: Record<string, number>;
  /** Margin between first and second place. A two-horse race is not a decision. */
  confidence: number;
}

export interface ScoreAnswer {
  kind: "score";
  /** Expected level index, normalized to [0,1]. */
  value: number;
  /** Nearest discrete level. */
  level: string;
  distribution: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion
    ? ChoiceAnswer
    : ScoreAnswer;

export type Answers<Q extends Record<string, Question>> = {
  [K in keyof Q]: AnswerFor<Q[K]>;
};

export interface Decider {
  /**
   * Answer every question against one state, independently.
   *
   * Questions are a map rather than a list so a caller asking three things
   * about one state pays for the state once and reads the answers by name.
   */
  ask<Q extends Record<string, Question>>(
    state: string,
    questions: Q,
  ): Promise<Answers<Q>>;
}

/** Embeds text into a unit-normalized vector. Injected so this module never
 *  pulls in a model runtime, and so tests can be deterministic. */
export type Embed = (text: string) => Promise<Float32Array>;

export interface LocalDeciderOptions {
  embed: Embed;
  /**
   * Softmax temperature over cosine similarity.
   *
   * Cosine between a sentence and a short label description occupies roughly
   * [0.0, 0.7] in practice, so a plain softmax over those numbers is nearly
   * uniform and every confidence reads as 0. Dividing by a small temperature
   * restores usable separation. 0.05 was chosen by sweeping against the
   * labelled vault (see `bench/` probe) — high enough not to saturate, low
   * enough that a clear winner reads as one.
   */
  temperature?: number;
  /**
   * Optional labelled examples per label, few-shot style. A label's prototype
   * becomes the mean of its description and its examples, which is the whole
   * SetFit result: a handful of examples over a static encoder beats a much
   * larger model prompted zero-shot.
   */
  examples?: Record<string, string[]>;
}

const DEFAULT_TEMPERATURE = 0.05;

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function softmax(scores: number[], temperature: number): number[] {
  const scaled = scores.map((s) => s / temperature);
  const max = Math.max(...scaled);
  const exp = scaled.map((s) => Math.exp(s - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((e) => e / total);
}

/** Weights for a multinomial logistic regression over embeddings. */
interface LinearHead {
  labels: string[];
  /** One weight vector per label. */
  weights: Float32Array[];
  bias: Float32Array;
}

/**
 * Multinomial logistic regression by SGD.
 *
 * Convex, so there is no local minimum to worry about and no initialization
 * strategy to tune. The decaying learning rate is the only concession to
 * running a fixed epoch count instead of to convergence.
 *
 * The per-epoch shuffle is NOT optional and is not a tuning detail. Callers
 * naturally assemble training data grouped by label - `{idea: [...],
 * decision: [...]}` is the obvious shape - and feeding SGD a label-sorted
 * stream lets whichever label comes last dominate the end of every epoch.
 * Measured on the same 1,206 vault examples: 33.8% sorted, 51.8% shuffled.
 * Same data, same objective, same epochs.
 */
function trainLinearHead(
  labels: string[],
  samples: Array<{ vector: Float32Array; label: number }>,
  options: { epochs?: number; learningRate?: number; l2?: number; seed?: number },
): LinearHead {
  const epochs = options.epochs ?? 220;
  const l2 = options.l2 ?? 1e-4;
  let rate = options.learningRate ?? 0.6;

  const dims = samples[0]!.vector.length;
  const weights = labels.map(() => new Float32Array(dims));
  const bias = new Float32Array(labels.length);

  // Seeded so a fit is reproducible; training that changes answers between
  // identical runs cannot be debugged.
  let seed = options.seed ?? 0x9e3779b9;
  const nextRandom = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 0xffffff) / 0xffffff;
  };

  const order = samples.map((_, i) => i);

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [order[i]!, order[j]!] = [order[j]!, order[i]!];
    }

    for (const index of order) {
      const { vector, label } = samples[index]!;
      const logits = labels.map((_, k) => dot(vector, weights[k]!) + bias[k]!);
      const max = Math.max(...logits);
      const exp = logits.map((z) => Math.exp(z - max));
      const total = exp.reduce((a, b) => a + b, 0);

      for (let k = 0; k < labels.length; k++) {
        const gradient = exp[k]! / total - (k === label ? 1 : 0);
        const w = weights[k]!;
        for (let j = 0; j < dims; j++) w[j]! -= rate * (gradient * vector[j]! + l2 * w[j]!);
        bias[k]! -= rate * gradient;
      }
    }
    rate *= 0.99;
  }

  return { labels, weights, bias };
}

/**
 * The default backend. Two modes, and the difference between them is large
 * enough that the caller has to know which one it is getting.
 *
 * FITTED (`fit()` called for the question): multinomial logistic regression
 * over the embedding. This is the mode worth using.
 *
 * UNFITTED: cosine against label prototypes built from the label descriptions.
 * Requires no labels, and is weak. Measured on 1,508 human-labelled vault
 * notes classifying note type over six labels:
 *
 *   always-guess-the-majority-class          34.3%
 *   prototype, descriptions only             16.4%
 *   prototype, 5 examples per label          18.5%
 *   prototype + per-label bias/scale         23.7%
 *   FITTED logreg head, 5-fold CV            51.8%
 *
 * Unfitted prototypes lose to a constant guess, and calibration recovers only
 * a third of the gap. The reason is visible in the errors: every note in a
 * personal vault is about the same handful of topics, so cosine against a
 * label description measures SUBJECT, and the labels here are rhetorical
 * function. Nothing about that is fixable by better wording of the criteria.
 *
 * So unfitted mode exists for the case where no labels exist yet, it reports
 * low confidence, and it should be treated as a placeholder rather than an
 * answer.
 */
export class LocalDecider implements Decider {
  private readonly embed: Embed;
  private readonly temperature: number;
  private readonly examples: Record<string, string[]>;
  private readonly prototypes = new Map<string, Float32Array>();
  private readonly heads = new Map<string, LinearHead>();

  constructor(options: LocalDeciderOptions) {
    this.embed = options.embed;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.examples = options.examples ?? {};
  }

  /** Labels this decider has a trained head for. */
  fitted(): string[] {
    return [...this.heads.keys()];
  }

  /**
   * Train a head for one question from labelled text.
   *
   * `question` is the key the caller will pass to `ask`, so a decider can hold
   * heads for several questions at once. Training is plain SGD on a convex
   * objective over a few hundred examples — hundreds of milliseconds, no
   * dependency, and it runs on the machine that owns the data.
   */
  async fit(
    question: string,
    labelled: Record<string, string[]>,
    options: { epochs?: number; learningRate?: number; l2?: number; seed?: number } = {},
  ): Promise<void> {
    const labels = Object.keys(labelled);
    if (labels.length < 2) throw new Error("fit needs at least two labels");

    const samples: Array<{ vector: Float32Array; label: number }> = [];
    for (const [label, texts] of Object.entries(labelled)) {
      const index = labels.indexOf(label);
      for (const text of texts) samples.push({ vector: await this.embed(text), label: index });
    }
    if (samples.length === 0) throw new Error("fit needs at least one example");

    this.heads.set(question, trainLinearHead(labels, samples, options));
  }

  /** Mean of the label's description and any examples given for it, re-normalized. */
  private async prototype(label: string, description: string): Promise<Float32Array> {
    const key = `${label}\u0000${description}`;
    const cached = this.prototypes.get(key);
    if (cached) return cached;

    const texts = [description, ...(this.examples[label] ?? [])];
    const vectors = await Promise.all(texts.map((t) => this.embed(t)));

    const mean = new Float32Array(vectors[0]!.length);
    for (const v of vectors) for (let i = 0; i < mean.length; i++) mean[i]! += v[i]!;

    let norm = 0;
    for (let i = 0; i < mean.length; i++) norm += mean[i]! * mean[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < mean.length; i++) mean[i]! /= norm;

    this.prototypes.set(key, mean);
    return mean;
  }

  private async distribution(
    state: Float32Array,
    labels: Array<[string, string]>,
  ): Promise<Record<string, number>> {
    const protos = await Promise.all(labels.map(([l, d]) => this.prototype(l, d)));
    const probs = softmax(protos.map((p) => dot(state, p)), this.temperature);
    const out: Record<string, number> = {};
    labels.forEach(([label], i) => (out[label] = probs[i]!));
    return out;
  }

  /** Softmax over a trained head. Temperature 1: the logits are already scaled
   *  by training, unlike raw cosine. */
  private headDistribution(state: Float32Array, head: LinearHead): Record<string, number> {
    const probs = softmax(
      head.labels.map((_, k) => dot(state, head.weights[k]!) + head.bias[k]!),
      1,
    );
    const out: Record<string, number> = {};
    head.labels.forEach((label, i) => (out[label] = probs[i]!));
    return out;
  }

  async ask<Q extends Record<string, Question>>(
    state: string,
    questions: Q,
  ): Promise<Answers<Q>> {
    const vector = await this.embed(state);
    const entries = Object.entries(questions) as Array<[keyof Q, Question]>;

    // Independent by construction, and they share one state embedding.
    const answered = await Promise.all(
      entries.map(async ([name, q]) => [name, await this.answer(String(name), vector, q)] as const),
    );

    const out = {} as Answers<Q>;
    for (const [name, answer] of answered) {
      out[name] = answer as Answers<Q>[typeof name];
    }
    return out;
  }

  private async answer(
    name: string,
    state: Float32Array,
    question: Question,
  ): Promise<Answer> {
    const head = this.heads.get(name);

    if (question.kind === "noul") {
      const dist = head
        ? this.headDistribution(state, head)
        : await this.distribution(state, [
            ["yes", question.poles.yes],
            ["no", question.poles.no],
          ]);
      const value = dist.yes ?? 0;
      // Distance from maximum uncertainty, so 0.5 reads as no confidence.
      return { kind: "noul", value, confidence: Math.abs(value - 0.5) * 2 };
    }

    if (question.kind === "choice") {
      const labels = Object.entries(question.criteria);
      if (labels.length === 0) throw new Error("choice question has no criteria");
      const dist = head
        ? this.headDistribution(state, head)
        : await this.distribution(state, labels);
      const ranked = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      return {
        kind: "choice",
        value: ranked[0]![0],
        distribution: dist,
        confidence: ranked[0]![1] - (ranked[1]?.[1] ?? 0),
      };
    }

    const levels = question.levels;
    if (levels.length === 0) throw new Error("score question has no levels");
    const dist = await this.distribution(state, levels.map((l) => [l, l]));
    // Expected position, not argmax: "between Frustrated and Very angry" is a
    // real answer and an ordinal scale is the one place it can be expressed.
    let expected = 0;
    levels.forEach((l, i) => (expected += dist[l]! * i));
    const normalized = levels.length > 1 ? expected / (levels.length - 1) : 0;
    const nearest = levels[Math.round(expected)]!;
    const top = Math.max(...Object.values(dist));
    return {
      kind: "score",
      value: normalized,
      level: nearest,
      distribution: dist,
      confidence: top,
    };
  }
}
