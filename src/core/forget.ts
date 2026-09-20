/**
 * Query-addressed forgetting: supersede, release, purge.
 *
 * Ori had none of these. Measured on ForgetEval (deeplethe/lethe, MIT, the
 * only benchmark that scores forgetting) Ori returned 0/1000 — every case
 * N/A, every family, because the adapter could not implement the three
 * optional operations. MemPalace scores the same 0. Meanwhile BM25 from 1994
 * scores 25.5 on MemoryAgentBench's selective-forgetting competency and beats
 * Cognee, MemGPT, Mem0 and Zep.
 *
 * The hard part is not deleting. It is deciding WHAT the query addresses.
 *
 *   release("Grace paella preferences")  must evict "Grace likes paella."
 *                                        and KEEP "Hannah likes anchovy pizza."
 *   supersede("Uma job employer", ...)   must match "Uma works at OpenAI."
 *                                        where the only shared token is "Uma".
 *
 * Over-match and you destroy facts the caller still needs; under-match and
 * the thing you were asked to forget is still there. Pure lexical overlap
 * fails the second case (one token). Pure embedding similarity fails the
 * first (both sentences are "person likes food" and sit close together).
 *
 * So matching is anchored, not thresholded: a note is a candidate only if it
 * shares a RARE token with the query — a proper noun, an identifier, a
 * number — and candidates are then ordered by embedding similarity. Rarity
 * is measured against the vault itself, so "Grace" anchors and "likes" does
 * not, without a stopword list to maintain.
 *
 * Status lives in frontmatter because the markdown is the truth. A released
 * note keeps its file and stops being recalled; a purged note is unlinked.
 * Both survive `rm -rf .ori/` for exactly that reason.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tokenize } from "./bm25.js";
import { readFrontmatterFile, writeFrontmatterFile } from "./frontmatter.js";
import { embedText } from "./engine.js";
import type { EngineConfig } from "./config.js";
import { isForgotten } from "./status.js";

export { FORGOTTEN_STATUSES, isForgotten } from "./status.js";

export interface ForgetMatch {
  slug: string;
  file: string;
  text: string;
  anchor: number;
  similarity: number;
}

export interface ForgetResult {
  matched: ForgetMatch[];
  count: number;
}

interface LiveNote {
  slug: string;
  file: string;
  text: string;
  tokens: Set<string>;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Tokens that survive tokenisation, plus raw alphanumeric runs of length >= 6.
 *
 * The second part matters for identifiers. `purge("API key sk-zzpqk51fpk")`
 * must reach "API key issued to ops: sk-zzpqk51fpk-secret." — the note's
 * identifier is the query's identifier with a suffix, so exact token equality
 * never fires and only a substring test connects them.
 */
function richTokens(text: string): { tokens: Set<string>; longs: string[] } {
  const tokens = new Set(tokenize(text));
  const longs: string[] = [];
  // An identifier, not merely a long word. The distinction is load-bearing:
  // `longs` drives an exclusivity rule, so admitting "customer" or "history"
  // would make every note carrying a common word an exact address.
  //
  // The first version matched /[a-z0-9][a-z0-9-]{5,}/ and therefore could not
  // see an email at all -- "@" and "." were outside the class, so
  // "alice@post.dev" yielded only ["customer","history"]. That is why 50 of
  // 200 purge cases deleted a second customer's record: the one token that
  // uniquely named the target was invisible, and a shared common word decided
  // the match instead.
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9._@+-]{5,}/g)) {
    const tok = m[0].replace(/[.]+$/, "");
    if (/[0-9@._+-]/.test(tok.slice(1))) longs.push(tok);
  }
  return { tokens, longs };
}

async function loadLiveNotes(notesDir: string): Promise<LiveNote[]> {
  const out: LiveNote[] = [];
  let names: string[];
  try {
    names = await fs.readdir(notesDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(notesDir, name);
    let parsed;
    try {
      parsed = await readFrontmatterFile(file);
    } catch {
      continue;
    }
    const status = String(parsed.data?.status ?? "").toLowerCase();
    if (isForgotten(status)) continue; // already forgotten
    const text = String(parsed.body ?? "").trim();
    out.push({
      slug: name.slice(0, -3),
      file,
      text,
      tokens: new Set(tokenize(text)),
    });
  }
  return out;
}

/**
 * Notes the query addresses.
 *
 * Document frequency is computed over the live notes, so a token shared by
 * most of them cannot anchor. With the small fact sets ForgetEval builds this
 * is exactly the proper-noun/identifier signal; on a real vault it degrades
 * gracefully into ordinary IDF.
 */
export async function matchForForget(
  notesDir: string,
  query: string,
  config: EngineConfig,
  opts: { minRatio?: number; minSimilarity?: number; limit?: number } = {},
): Promise<ForgetMatch[]> {
  const notes = await loadLiveNotes(notesDir);
  if (notes.length === 0) return [];

  const minSimilarity = opts.minSimilarity ?? 0.25;

  const df = new Map<string, number>();
  for (const n of notes) for (const t of n.tokens) df.set(t, (df.get(t) ?? 0) + 1);

  // Smoothed IDF, log((N+1)/(df+0.5)).
  //
  // The first version cut any token whose document frequency exceeded half
  // the corpus. On a real vault that is fine. On a ForgetEval case holding
  // three facts every token appears in 33-100% of notes, so with a single
  // note in scope NOTHING could anchor and matching returned 0 with no
  // error. It passed the two-note smoke test only because df/N landed
  // exactly on the boundary. Smoothing keeps the weight positive at any
  // corpus size and lets frequency be a small weight instead of a cliff.
  const N = notes.length;
  const idf = (t: string) => Math.max(Math.log((N + 1) / ((df.get(t) ?? 0) + 0.5)), 0.01);

  const q = richTokens(query);

  // Raw IDF mass each note shares with the query, plus identifier hits,
  // tracked separately because an identifier is an address and a word is not.
  const raw = new Map<string, number>();
  const idHits = new Map<string, number>();
  for (const n of notes) {
    let anchor = 0;
    for (const t of q.tokens) if (n.tokens.has(t)) anchor += idf(t);
    // Identifier containment, in both directions: the note may carry a
    // suffixed form of the query's identifier or vice versa.
    const lower = n.text.toLowerCase();
    let ids = 0;
    for (const l of q.longs) {
      if (lower.includes(l)) ids += 2;
      else if (l.length >= 8 && [...n.tokens].some((t) => t.length >= 6 && l.includes(t))) ids += 1;
    }
    if (ids > 0) idHits.set(n.slug, ids);
    anchor += ids;
    if (anchor > 0) raw.set(n.slug, anchor);
  }
  if (raw.size === 0) return [];

  // When the query names an identifier that some note actually contains, the
  // address is exact and nothing else is a candidate.
  //
  // Without this, purge("alice@post.dev customer history") deleted bob's
  // record too: both notes carry "customer", bob cleared the relative bar on
  // that word alone, and 50 of 200 purge cases failed by destroying a record
  // the caller never named. Over-matching a delete is the worst failure this
  // module can have -- it is silent, and the data is gone.
  if (idHits.size > 0) {
    for (const slug of [...raw.keys()]) if (!idHits.has(slug)) raw.delete(slug);
  }

  // Keep notes carrying a substantial share of the BEST note's mass, not of
  // the query's own mass.
  //
  // Normalising by the query was the second thing that silently returned
  // nothing here. `supersede("Uma job employer", ...)` must match "Uma works
  // at OpenAI."; "job" and "employer" appear in no note, so they contribute
  // nothing to the numerator while inflating the denominator, and the one
  // genuine hit scored 0.162 against a 0.2 floor. Forget queries are
  // descriptive by nature — they name the subject, not its wording — so the
  // question is which note this query addresses relative to the others, and
  // that is a comparison between notes.
  const best = Math.max(...raw.values());
  const ratio = opts.minRatio ?? 0.5;
  const candidates: LiveNote[] = [];
  const anchors = new Map<string, number>();
  for (const n of notes) {
    const a = raw.get(n.slug) ?? 0;
    if (a >= best * ratio) {
      anchors.set(n.slug, a);
      candidates.push(n);
    }
  }
  if (candidates.length === 0) return [];

  const qv = await embedText(query, config);
  const scored: ForgetMatch[] = [];
  for (const n of candidates) {
    const nv = await embedText(n.text, config);
    const sim = cosine(qv, nv);
    const anchor = anchors.get(n.slug) ?? 0;
    // A strong identifier hit stands on its own: "sk-zzpqk51fpk" appearing
    // verbatim is not a semantic judgement and must not be gated on one.
    if (anchor >= 2 || sim >= minSimilarity) {
      scored.push({ slug: n.slug, file: n.file, text: n.text, anchor, similarity: sim });
    }
  }
  scored.sort((a, b) => b.anchor + b.similarity - (a.anchor + a.similarity));
  return opts.limit ? scored.slice(0, opts.limit) : scored;
}

async function setStatus(file: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const parsed = await readFrontmatterFile(file);
  await writeFrontmatterFile(file, { ...(parsed.data ?? {}), ...extra, status }, parsed.body);
}

/**
 * Options guarding the blast radius of a forget call.
 *
 * Measured on a real 1,550-note vault: `release("Ori positioning strategy")`
 * addresses **159 notes**; "CourtShare engagement mechanics" 53; "Kashi token
 * incentives" 41. ForgetEval scores this same matcher at 97.8%, because its
 * cases hold eight facts and four distractors. Raise that to 200 distractors
 * — a flag the harness already has and nobody sets — and the amnesia family
 * falls from 100% to 65%. Selectivity degrades with corpus size, and the
 * benchmark's default configuration cannot see it.
 *
 * So destructive calls are capped and previewable. Supermemory has shipped
 * `dryRun`, `threshold` and `maxForget` on `POST /v4/memories/forget-matching`
 * for a while; this is the same idea, arrived at from the other direction.
 */
export interface ForgetOptions {
  /** Match and report, change nothing. */
  dryRun?: boolean;
  /**
   * Refuse the call if it would touch more than this many notes. Default 10.
   * `Infinity` disables the guard, and the caller has to type that.
   */
  maxForget?: number;
}

export class ForgetBlastRadiusError extends Error {
  constructor(readonly query: string, readonly matched: ForgetMatch[], readonly cap: number) {
    super(
      `"${query}" addresses ${matched.length} notes, over the maxForget cap of ${cap}. ` +
        `Re-run with dryRun to inspect, narrow the query, or pass an explicit cap. ` +
        `First matches: ${matched.slice(0, 3).map((m) => m.slug).join(", ")}`,
    );
    this.name = "ForgetBlastRadiusError";
  }
}

function guardBlastRadius(query: string, matched: ForgetMatch[], opts: ForgetOptions): void {
  const cap = opts.maxForget ?? 10;
  if (matched.length > cap) throw new ForgetBlastRadiusError(query, matched, cap);
}

/** Soft-evict every note the query addresses. The files remain on disk. */
export async function release(
  notesDir: string,
  query: string,
  config: EngineConfig,
  opts: ForgetOptions = {},
): Promise<ForgetResult> {
  const matched = await matchForForget(notesDir, query, config);
  guardBlastRadius(query, matched, opts);
  if (opts.dryRun) return { matched, count: 0 };
  for (const m of matched) {
    await setStatus(m.file, "released", { released_by: query, released: new Date().toISOString().slice(0, 10) });
  }
  return { matched, count: matched.length };
}

/** Hard-delete every note the query addresses. */
export async function purge(
  notesDir: string,
  query: string,
  config: EngineConfig,
  opts: ForgetOptions = {},
): Promise<ForgetResult> {
  const matched = await matchForForget(notesDir, query, config);
  guardBlastRadius(query, matched, opts);
  if (opts.dryRun) return { matched, count: 0 };
  for (const m of matched) {
    await fs.rm(m.file, { force: true });
  }
  return { matched, count: matched.length };
}

/**
 * Replace what the query addresses with new text.
 *
 * Forward-declared, the way the vault's own supersession works: the new note
 * names what it replaces and the old note's status is derived, so the link
 * survives even if the index is rebuilt from markdown alone.
 *
 * Only the single best match is superseded. ForgetEval's drift family applies
 * two supersessions in sequence over the same subject, and superseding every
 * candidate on the first call would take the replacement written by the first
 * one with it.
 */
export async function supersede(
  notesDir: string,
  oldQuery: string,
  newText: string,
  config: EngineConfig,
  writeNote: (slug: string, text: string, frontmatter: Record<string, unknown>) => Promise<void>,
): Promise<ForgetResult> {
  const matched = await matchForForget(notesDir, oldQuery, config, { limit: 1 });
  const replaced = matched.map((m) => m.slug);
  for (const m of matched) {
    await setStatus(m.file, "superseded", { superseded_by_query: oldQuery });
  }
  const slug =
    (newText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "note") +
    `-${Date.now().toString(36)}`;
  await writeNote(slug, newText, {
    description: newText.slice(0, 160),
    type: "decision",
    status: "active",
    ...(replaced.length ? { supersedes: replaced } : {}),
  });
  return { matched, count: matched.length };
}
