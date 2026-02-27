export type VitalityParams = {
  base: number;
  decayDays: number;
};

export function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(b.getTime() - a.getTime());
  return ms / (1000 * 60 * 60 * 24);
}

export function computeVitality(
  params: VitalityParams,
  lastAccessed: Date,
  now: Date
): number {
  if (params.decayDays <= 0) {
    return params.base;
  }
  const t = daysBetween(lastAccessed, now);
  const v = params.base * Math.exp(-t / params.decayDays);
  return Math.max(0, Math.min(params.base, v));
}

/**
 * ACT-R base-level activation: B_i = ln(n/(1-d)) - d*ln(L)
 * Normalized to 0-1 via sigmoid.
 *
 * @param accessCount - number of times the note was accessed (n)
 * @param lifetimeDays - days since note creation (L)
 * @param d - decay parameter, default 0.5
 * @returns vitality score 0-1
 */
export function computeVitalityACTR(
  accessCount: number,
  lifetimeDays: number,
  d: number = 0.5
): number {
  if (accessCount <= 0) return 0.5; // cold start baseline
  if (lifetimeDays <= 0) return 1.0; // brand new note

  // Clamp d to (0, 0.99) to keep (1 - d) positive
  const dClamped = Math.max(0.01, Math.min(d, 0.99));
  const B = Math.log(accessCount / (1 - dClamped)) - dClamped * Math.log(lifetimeDays);
  // Sigmoid normalization to [0, 1]
  return 1 / (1 + Math.exp(-B));
}

/**
 * Structural stability boost from incoming links.
 * Each link adds ~10% to effective stability, capped at 2x.
 */
export function computeStructuralBoost(inDegree: number): number {
  return 1 + 0.1 * Math.min(inDegree, 10);
}

/**
 * Revival spike when a dormant note gets a new connection.
 * Decays exponentially over 14 days.
 */
export function computeRevivalBoost(daysSinceNewConnection: number | undefined): number {
  if (daysSinceNewConnection === undefined || daysSinceNewConnection < 0) return 0;
  if (daysSinceNewConnection >= 14) return 0;
  return Math.exp(-0.2 * daysSinceNewConnection);
}

/**
 * Access frequency saturation with diminishing returns.
 * 10 accesses → ~63%, 20 → ~86%, 30 → ~95%.
 */
export function computeAccessSaturation(accessCount: number, k: number = 10): number {
  if (accessCount <= 0) return 0;
  return 1 - Math.exp(-accessCount / k);
}

export type VitalityFullParams = {
  accessCount: number;
  created: string;        // ISO date string
  lastAccessed?: string;  // ISO date string
  noteTitle: string;
  inDegree: number;
  bridges: Set<string>;
  metabolicRate?: number; // self/=0.1, notes/=1.0, ops/=3.0
  daysSinceNewConnection?: number;
  actrDecay?: number;     // default 0.5
  accessSaturationK?: number; // default 10
  bridgeFloor?: number;   // default 0.5
};

/**
 * Full vitality computation combining:
 * 1. ACT-R base vitality
 * 2. Metabolic rate (space-dependent decay multiplier)
 * 3. Structural stability boost (well-linked notes decay slower)
 * 4. Access frequency saturation
 * 5. Revival spike for dormant notes gaining new connections
 * 6. Bridge protection floor
 */
export function computeVitalityFull(params: VitalityFullParams): number {
  const {
    accessCount,
    created,
    noteTitle,
    inDegree,
    bridges,
    metabolicRate = 1.0,
    daysSinceNewConnection,
    actrDecay = 0.5,
    accessSaturationK = 10,
    bridgeFloor = 0.5,
  } = params;

  const createdDate = new Date(created);
  const now = new Date();
  const lifetimeDays = daysBetween(createdDate, now);

  // 1. ACT-R base with metabolic-adjusted decay
  const effectiveDecay = actrDecay * metabolicRate;
  let vitality = computeVitalityACTR(accessCount, lifetimeDays, effectiveDecay);

  // 2. Structural stability boost (stretches the effective half-life)
  const structuralBoost = computeStructuralBoost(inDegree);
  // Apply boost: higher boost = higher vitality (multiply and re-normalize)
  vitality = vitality * structuralBoost;

  // 3. Access saturation modulation
  const saturation = computeAccessSaturation(accessCount, accessSaturationK);
  // Blend: base vitality + saturation contribution
  vitality = vitality * (0.5 + 0.5 * saturation);

  // 4. Revival spike
  const revival = computeRevivalBoost(daysSinceNewConnection);
  vitality = vitality + revival * 0.2; // Revival adds up to 20% boost

  // 5. Bridge protection floor
  if (bridges.has(noteTitle)) {
    vitality = Math.max(vitality, bridgeFloor);
  }

  // 6. Clamp to [0, 1]
  return Math.max(0, Math.min(1, vitality));
}