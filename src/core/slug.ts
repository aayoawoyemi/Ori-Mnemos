/**
 * Canonical title → filename slug conversion.
 * Single source of truth shared by note creation (add.ts) and
 * link-graph normalization (graph.ts) so the two can never drift (#32).
 */
/** Max slug length. Windows MAX_PATH is 260 for the full path; a 265-char
 *  filename in notes/ was unreadable and unindexable on 2026-09-06. 120 leaves
 *  room for any sane vault root. Cut on a word boundary so the tail is not a
 *  fragment. */
export const MAX_SLUG_LENGTH = 120;

export function slugify(title: string): string {
  const full = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  if (full.length <= MAX_SLUG_LENGTH) return full;
  const cut = full.slice(0, MAX_SLUG_LENGTH);
  const boundary = cut.lastIndexOf("-");
  return (boundary > MAX_SLUG_LENGTH / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/, "");
}
