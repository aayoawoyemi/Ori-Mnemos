/**
 * Canonical title → filename slug conversion.
 * Single source of truth shared by note creation (add.ts) and
 * link-graph normalization (graph.ts) so the two can never drift (#32).
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
