/**
 * Note lifecycle statuses that remove a note from retrieval.
 *
 * A leaf module on purpose. `forget.ts` needs this and imports `engine.ts`
 * for the embedder, while `engine.ts` needs it too — defining it in either
 * makes the cycle. Nothing here imports anything.
 *
 * Until 2026-09-19 only `archived` was filtered, and it was spelled as a
 * string literal at four separate sites: two in indexstore.ts governing the
 * link graph, one in explore.ts governing results, one in engine.ts governing
 * embedding. Adding `superseded` and `released` by hand at four sites is how
 * three of them end up agreeing and the fourth quietly does not.
 */
export const FORGOTTEN_STATUSES: ReadonlySet<string> = new Set([
  "archived",
  "superseded",
  "released",
]);

/** True when a note's frontmatter status takes it out of retrieval. */
export function isForgotten(status: unknown): boolean {
  return typeof status === "string" && FORGOTTEN_STATUSES.has(status.toLowerCase());
}
