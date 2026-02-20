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