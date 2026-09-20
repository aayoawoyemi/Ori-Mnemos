// Persistent NDJSON bridge so ForgetEval (Python) can drive Ori (Node).
//
// ForgetEval issues ~10 adapter calls per case over 1,000 cases. A
// subprocess-per-call CLI at ~1 s of Node startup each would take three hours
// of process spawning to do ten minutes of work, so this stays resident:
// one line of JSON in, one line of JSON out.
//
// It imports `ori-memory` as a library rather than shelling out, which is
// only possible as of 0.7.1 — before that the package had no exports and a
// bare import threw. First real consumer of that surface.
//
// Protocol (one JSON object per line):
//   {"op":"reset"}                        -> {"ok":true}
//   {"op":"inscribe","text":"..."}        -> {"ok":true,"id":"<slug>"}
//   {"op":"recall","query":"...","k":10}  -> {"ok":true,"texts":[...]}
//   {"op":"supersede","old":"...","new":"..."} | {"op":"release","query":"..."}
//   {"op":"purge","query":"..."}          -> {"ok":true,"count":N}
//   {"op":"bye"}                          -> exits
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall as oriRecall, supersede, release, purge, loadConfig } from "ori-memory";

let vault = null;

const notesDir = () => join(vault, "notes");

let cfgCache = null;
async function config() {
  // Same loader the CLI uses, so the embedder here is the embedder there.
  if (!cfgCache) cfgCache = (await loadConfig(join(vault, "ori.config.yaml"))).engine;
  return cfgCache;
}

function frontmatter(fm) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(String(v)).slice(1, -1)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function slugify(text, n = 72) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, n) || "note"
  );
}

function freshVault() {
  if (vault) {
    try { rmSync(vault, { recursive: true, force: true }); } catch {}
  }
  vault = mkdtempSync(join(tmpdir(), "fe-ori-"));
  mkdirSync(join(vault, "notes"), { recursive: true });
  mkdirSync(join(vault, ".ori"), { recursive: true });
  writeFileSync(join(vault, "ori.config.yaml"), "engine:\n  db_path: .ori/embeddings.db\n");
  return vault;
}

let seq = 0;
const seen = new Map(); // slug -> full text, so recall can return what was inscribed

function inscribe(text) {
  // ForgetEval inscribes raw factual sentences. Ori is note-shaped, so the
  // sentence becomes both the title (slugified, deduped) and the body. The
  // body is what recall must return: the scorer substring-matches against it.
  let slug = slugify(text);
  if (seen.has(slug)) slug = `${slug}-${++seq}`;
  seen.set(slug, text);
  const fm = `---\ndescription: ${JSON.stringify(text).slice(1, -1)}\ntype: insight\ncreated: 2026-09-19\n---\n\n${text}\n`;
  writeFileSync(join(vault, "notes", `${slug}.md`), fm, "utf8");
  return slug;
}

async function recall(query, k) {
  const res = await oriRecall(vault, query, { limit: k });
  const list = res?.data?.results ?? res?.results ?? [];
  return list.slice(0, k).map((h) => {
    const slug = h.title ?? h.slug ?? h.id;
    // Return the exact inscribed sentence. The scorer lowercases the joined
    // top-k and does substring containment, so a truncated preview would
    // fail must_contain for reasons that have nothing to do with ranking.
    return seen.get(slug) ?? h.snippet?.preview ?? h.preview ?? h.text ?? String(slug);
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");

for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try { req = JSON.parse(line); } catch { say({ ok: false, error: "bad json" }); continue; }
  try {
    switch (req.op) {
      case "reset":
        freshVault();
        cfgCache = null;
        seen.clear();
        seq = 0;
        say({ ok: true });
        break;
      case "inscribe":
        say({ ok: true, id: inscribe(req.text) });
        break;
      case "recall":
        say({ ok: true, texts: await recall(req.query, req.k ?? 10) });
        break;
      // Query-addressed forgetting, as of src/core/forget.ts. Before that
      // these returned unsupported and ForgetEval scored 0/1000.
      case "supersede": {
        const cfg = await config();
        const r = await supersede(notesDir(), req.old, req.new, cfg, async (slug, text, fm) => {
          seen.set(slug, text);
          writeFileSync(join(notesDir(), `${slug}.md`), frontmatter(fm) + text + "\n", "utf8");
        }, { apply: true, maxForget: Infinity });
        say({ ok: true, count: r.count });
        break;
      }
      case "release": {
        const r = await release(notesDir(), req.query, await config(), { apply: true, maxForget: Infinity });
        for (const m of r.matched) seen.delete(m.slug);
        say({ ok: true, count: r.count });
        break;
      }
      case "purge": {
        const r = await purge(notesDir(), req.query, await config(), { apply: true, maxForget: Infinity });
        for (const m of r.matched) seen.delete(m.slug);
        say({ ok: true, count: r.count });
        break;
      }
      case "bye":
        if (vault) { try { rmSync(vault, { recursive: true, force: true }); } catch {} }
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        say({ ok: false, error: `unknown op ${req.op}` });
    }
  } catch (e) {
    say({ ok: false, error: String(e?.message ?? e) });
  }
}
