import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchForForget, release, purge, ForgetBlastRadiusError } from "../../src/core/forget.js";
import { isForgotten, FORGOTTEN_STATUSES } from "../../src/core/status.js";
import type { EngineConfig } from "../../src/core/config.js";

// Matching is the whole difficulty of forgetting: over-match and you destroy
// facts nobody asked you to forget, under-match and the secret is still there.
// Each case below is one that actually failed during the ForgetEval run.

const config = { embedding_model: "Xenova/all-MiniLM-L6-v2" } as unknown as EngineConfig;

let dir: string;
let notes: string;

function note(slug: string, text: string, status?: string) {
  const st = status ? `status: ${status}\n` : "";
  writeFileSync(join(notes, `${slug}.md`), `---\ndescription: ${text}\ntype: insight\n${st}---\n\n${text}\n`, "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forget-"));
  notes = join(dir, "notes");
  mkdirSync(notes, { recursive: true });
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe("forgotten statuses", () => {
  it("treats superseded and released like archived", () => {
    for (const s of ["archived", "superseded", "released"]) expect(isForgotten(s)).toBe(true);
    expect(isForgotten("active")).toBe(false);
    expect(isForgotten(undefined)).toBe(false);
    expect(FORGOTTEN_STATUSES.size).toBe(3);
  });
});

describe("matchForForget", () => {
  it("matches on a single shared rare token when the rest of the query is descriptive", async () => {
    // supersede("Uma job employer") must reach "Uma works at OpenAI." — only
    // "uma" is shared. Normalising by the query's own token mass scored this
    // 0.162 against a 0.2 floor and matched nothing, silently.
    note("uma", "Uma works at OpenAI.");
    note("toner", "Photocopier toner was reordered.");
    const m = await matchForForget(notes, "Uma job employer", config);
    expect(m.map((x) => x.slug)).toEqual(["uma"]);
  });

  it("anchors when the corpus is a single note", async () => {
    // The first implementation cut tokens with df/N above 0.5. With one note
    // every token is at 1.0, so nothing could anchor and match returned [].
    note("uma", "Uma works at OpenAI.");
    const m = await matchForForget(notes, "Uma job employer", config);
    expect(m).toHaveLength(1);
  });

  it("does not evict a bystander who shares only a common word", async () => {
    // release("Grace paella preferences") must not touch Hannah.
    note("grace", "Grace likes paella.");
    note("hannah", "Hannah likes anchovy pizza.");
    const m = await matchForForget(notes, "Grace paella preferences", config);
    expect(m.map((x) => x.slug)).toEqual(["grace"]);
  });

  it("treats an identifier as an exact address", async () => {
    // purge("alice@post.dev customer history") deleted bob's record in 50 of
    // 200 ForgetEval cases: both notes carry "customer", and the email was
    // invisible to an identifier regex that excluded "@" and ".".
    note("alice", "Customer alice@post.dev bought 3 items last week.");
    note("bob", "Customer bob@post.dev placed an order yesterday.");
    const m = await matchForForget(notes, "alice@post.dev customer history", config);
    expect(m.map((x) => x.slug)).toEqual(["alice"]);
  });

  it("matches an identifier the note carries with a suffix", async () => {
    note("key", "API key issued to ops: sk-zzpqk51fpk-secret.");
    note("bike", "The bicycle rack near the lobby was repainted.");
    const m = await matchForForget(notes, "API key sk-zzpqk51fpk", config);
    expect(m.map((x) => x.slug)).toEqual(["key"]);
  });

  it("skips notes that are already forgotten", async () => {
    note("grace", "Grace likes paella.", "released");
    const m = await matchForForget(notes, "Grace paella preferences", config);
    expect(m).toEqual([]);
  });
});

describe("release and purge", () => {
  it("release keeps the file and marks it, so it survives a rebuilt index", async () => {
    note("otp", "Session OTP for Bob: 211755.");
    note("coffee", "Bob likes iced coffee in the afternoon.");
    const r = await release(notes, "OTP login session code 211755", config, { apply: true });
    expect(r.count).toBe(1);
    const file = join(notes, "otp.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("status: released");
    // The bystander is untouched and still has no status.
    expect(readFileSync(join(notes, "coffee.md"), "utf8")).not.toContain("status:");
  });

  it("purge unlinks the file", async () => {
    note("key", "API key issued to ops: sk-zzpqk51fpk-secret.");
    note("bike", "The bicycle rack near the lobby was repainted.");
    const r = await purge(notes, "API key sk-zzpqk51fpk", config, { apply: true });
    expect(r.count).toBe(1);
    expect(existsSync(join(notes, "key.md"))).toBe(false);
    expect(existsSync(join(notes, "bike.md"))).toBe(true);
  });
});

describe("blast radius", () => {
  // On the real 1,550-note vault, release("Ori positioning strategy") matches
  // 159 notes. ForgetEval rates the same matcher 97.8% because its cases hold
  // eight facts. Destructive calls are capped so the gap between those two
  // numbers cannot become data loss.
  function manyMatching() {
    for (let i = 0; i < 25; i++) note(`grace-${i}`, `Grace likes paella variant ${i}.`);
  }

  it("refuses a release wider than maxForget instead of doing it", async () => {
    manyMatching();
    await expect(release(notes, "Grace paella preferences", config, { apply: true })).rejects.toThrow(
      /addresses \d+ notes, over the maxForget cap of 10/,
    );
    // Nothing was written before the throw.
    expect(readFileSync(join(notes, "grace-0.md"), "utf8")).not.toContain("status:");
  });

  it("refuses a purge the same way, and deletes nothing", async () => {
    manyMatching();
    await expect(purge(notes, "Grace paella preferences", config, { apply: true })).rejects.toThrow(ForgetBlastRadiusError);
    expect(existsSync(join(notes, "grace-0.md"))).toBe(true);
  });

  it("changes nothing unless the caller passes apply", async () => {
    note("otp", "Session OTP for Bob: 211755.");
    const r = await release(notes, "OTP login session code 211755", config);
    expect(r.matched).toHaveLength(1);
    expect(r.count).toBe(0);
    expect(readFileSync(join(notes, "otp.md"), "utf8")).not.toContain("status: released");
  });

  it("an explicit cap lets a wide call through — the caller has to say so", async () => {
    manyMatching();
    const r = await release(notes, "Grace paella preferences", config, { apply: true, maxForget: Infinity });
    expect(r.count).toBeGreaterThan(10);
  });
});
