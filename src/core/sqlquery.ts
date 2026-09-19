/**
 * Read-only SQL over the memory index.
 *
 * Ori ships fixed tools for a fixed set of questions -- orphans, dangling
 * links, backlinks, cross-project, most-important. That set is a sample of an
 * unbounded space, and the interesting questions are the ones nobody
 * anticipated: which notes have never been retrieved, which are surfaced
 * constantly and never rewarded, which map absorbs proposals it has no claim
 * to. This is that space, exposed once.
 *
 * Three independent layers stand between a caller and a write, because any one
 * of them can be wrong:
 *
 *   1. validateReadOnlySql -- a prefix rule. The first token must be SELECT,
 *      WITH, EXPLAIN or VALUES. This is what blocks ATTACH; better-sqlite3
 *      does not.
 *   2. stmt.readonly -- the driver's own verdict on a prepared statement.
 *      Catches anything the parser waved through.
 *   3. A worker thread holding a connection opened readonly with
 *      query_only = 1, so even a bug in 1 and 2 cannot reach a writable
 *      handle.
 *
 * Layer 1 is a parser and parsers are wrong; it exists to give a good error
 * message, not to be the guarantee. Layers 2 and 3 are the guarantee.
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export interface SqlOptions {
  rowCap: number;
  timeoutMs: number;
  maxCellBytes?: number;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  elapsedMs: number;
  warnings: string[];
}

export type Validation =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

const MAX_SQL_BYTES = 16 * 1024;
const ALLOWED_PREFIX = /^(SELECT|WITH|EXPLAIN|VALUES)\b/i;

/**
 * Tokens that must not appear anywhere outside a string literal. The prefix
 * rule already rejects a statement that *starts* with these; this catches them
 * in a position the prefix rule cannot see, e.g. `WITH x AS (...) ATTACH ...`.
 */
const FORBIDDEN = [
  "attach", "detach", "pragma", "vacuum", "insert", "update", "delete",
  "replace", "drop", "alter", "create", "reindex", "begin", "commit",
  "rollback", "savepoint", "load_extension", "writefile", "readfile",
  "edit", "fts5_config",
];

/**
 * Strip comments and string literals so the scan below cannot be fooled by a
 * keyword inside quoted text, and cannot miss one hidden behind a comment.
 * Returns the remaining code with literals blanked, preserving length so any
 * offset reported stays meaningful.
 */
function stripLiteralsAndComments(sql: string): { code: string; unterminated: boolean } {
  let out = "";
  let i = 0;
  let unterminated = false;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) { unterminated = true; while (i < sql.length) { out += " "; i++; } break; }
      while (i <= end + 1) { out += " "; i++; }
      continue;
    }
    // Only a single-quoted string is *data*. SQLite also accepts "…", […]
    // and `…` as quoted identifiers, and blanking those hid a real bypass:
    // SELECT "load_extension"('x') reached the engine and was stopped only by
    // the authorizer, one layer in from where it should have died. A quoted
    // identifier is still a name, so it is unquoted in place and stays
    // visible to the keyword scan.
    if (c === "'") {
      out += " ";
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "'") {
          // '' inside a '…' literal is an escaped quote, not the end.
          if (sql[i + 1] === "'") { out += "  "; i += 2; continue; }
          out += " ";
          i++;
          closed = true;
          break;
        }
        out += " ";
        i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    if (c === '"' || c === "[" || c === "`") {
      const close = c === "[" ? "]" : c;
      out += " ";               // the opening quote becomes a word boundary
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) { out += sql[i] + sql[i + 1]; i += 2; continue; }
          out += " ";           // and so does the closing quote
          i++;
          closed = true;
          break;
        }
        out += sql[i];          // identifier text kept, so the scan can see it
        i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, unterminated };
}

export function validateReadOnlySql(raw: string): Validation {
  if (typeof raw !== "string") return { ok: false, reason: "sql must be a string" };
  if (Buffer.byteLength(raw, "utf8") > MAX_SQL_BYTES) {
    return { ok: false, reason: `sql exceeds ${MAX_SQL_BYTES} bytes` };
  }

  const { code, unterminated } = stripLiteralsAndComments(raw);
  if (unterminated) return { ok: false, reason: "unterminated string or comment" };

  const trimmed = code.trim();
  if (trimmed === "") return { ok: false, reason: "empty statement" };

  const prefix = ALLOWED_PREFIX.exec(trimmed);
  if (!prefix) {
    const token = /^[A-Za-z_][A-Za-z_0-9]*/.exec(trimmed)?.[0] ?? trimmed.slice(0, 16);
    return {
      ok: false,
      reason: `only SELECT, WITH, EXPLAIN and VALUES are allowed; got "${token}"`,
    };
  }

  // One statement. A trailing ';' is fine; anything after it is not.
  const semi = trimmed.indexOf(";");
  if (semi !== -1 && trimmed.slice(semi + 1).trim() !== "") {
    return { ok: false, reason: "single statement only" };
  }

  const body = semi === -1 ? trimmed : trimmed.slice(0, semi);
  const lowered = body.toLowerCase();
  for (const word of FORBIDDEN) {
    // Word boundaries, so "created" does not match "create" and a column
    // called "update_count" does not match "update".
    if (new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`).test(lowered)) {
      return { ok: false, reason: `"${word}" is not allowed in a read-only query` };
    }
  }

  return { ok: true, sql: raw.trim() };
}

const WORKER_URL = new URL("./sqlquery-worker.js", import.meta.url);

export async function runReadOnlySql(
  dbPath: string,
  sql: string,
  opts: SqlOptions,
): Promise<SqlResult> {
  const started = Date.now();
  const validation = validateReadOnlySql(sql);
  if (!validation.ok) {
    return { columns: [], rows: [], truncated: false, elapsedMs: 0, warnings: [validation.reason] };
  }

  // A child process, not a worker thread.
  //
  // Worker.terminate() only lands between operations, so a worker parked
  // inside one synchronous SQLite call -- `WITH RECURSIVE ... SELECT COUNT(*)`
  // is the easy example -- ignores it forever. unref() did not help either:
  // Node would not exit while that thread spun, so the CLI printed the
  // correct timeout JSON at 1.5 s and then sat burning a core until killed.
  // Observed every time.
  //
  // Killing the process was not an option, because the MCP server calls this
  // same function and would take the whole server down with it. A child
  // process can be SIGKILLed: the runaway query dies, the caller lives, and
  // the timeout means what it says.
  return new Promise<SqlResult>((resolve) => {
    let settled = false;
    const finish = (r: SqlResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(r);
    };

    const child = fork(fileURLToPath(WORKER_URL), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        ORI_SQL_JOB: JSON.stringify({
          dbPath,
          sql: validation.sql,
          rowCap: opts.rowCap,
          maxCellBytes: opts.maxCellBytes ?? 4096,
        }),
      },
    });

    const timer = setTimeout(() => {
      finish({
        columns: [], rows: [], truncated: false,
        elapsedMs: Date.now() - started,
        warnings: [`SQL timed out after ${opts.timeoutMs} ms`],
      });
    }, opts.timeoutMs);

    child.on("message", (msg) => {
      // IPC payload: shape is fixed by the child we spawned, not by a caller.
      const m = msg as SqlResult & { error?: string };
      if (m.error !== undefined) {
        finish({
          columns: [], rows: [], truncated: false,
          elapsedMs: Date.now() - started, warnings: [m.error],
        });
        return;
      }
      finish({ ...m, elapsedMs: Date.now() - started });
    });

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) => {
      finish({
        columns: [], rows: [], truncated: false,
        elapsedMs: Date.now() - started, warnings: [err.message],
      });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim().split("\n").pop() ?? "";
      finish({
        columns: [], rows: [], truncated: false,
        elapsedMs: Date.now() - started,
        warnings: [
          `sql child exited ${signal !== null ? `on ${signal}` : `with code ${code}`}` +
            (detail ? `: ${detail}` : ""),
        ],
      });
    });
  });
}

/** One line per table, so the agent knows what it is looking at. */
const SCHEMA_DOCS: Record<string, string> = {
  v_note: "one row per note: slug, title, type, modified, access_count, inbound, outbound, pagerank, betweenness, q_value. Start here.",
  v_link: "wiki-link edges that resolve, as (src, src_title, dst, dst_title)",
  v_dangling: "wiki-link targets that do not exist, with how many notes cite them",
  v_retrieval: "every note ever returned to you: session_id, timestamp, query_text, slug, rank, final_score",
  v_session: "one row per session: when it started and ended, how many distinct queries",
  v_stage: "retrieval stage decisions and their rewards, one row per stage per query",
  note: "physical note table; prefer v_note",
  edge: "physical link table keyed by integer note id; prefer v_link",
  note_project: "project tags, (note_id, project); note_id is an integer joining note.id",
  note_term: "term postings, note_id is an integer joining note.id -- NOT a slug",
  note_q: "learned Q-value per note, keyed by SLUG not id",
  retrieval_log: "raw retrieval rows; note_id here is a SLUG, not an integer",
  co_occurrence: "pair counts; source=bootstrap is wiki-link derived, retrieval is observed",
  graph_metric: "pagerank and betweenness per note, (note_id, metric, value)",
  embeddings: "vectors as float32 blobs; not useful from SQL",
  index_meta: "derived-cache bookkeeping, including the graph metrics JSON",
};

export function describeSchema(dbPath: string): {
  tables: Array<{ name: string; kind: string; ddl: string; doc: string; rows: number }>;
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // better-sqlite3 types .all() as unknown[]; the row shape here is fixed by
    // the column list one line above, not by anything a caller supplies.
    const objects = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master " +
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name",
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>;

    return {
      tables: objects.map((o) => {
        let rows = -1;
        try {
          const counted: unknown = db.prepare(`SELECT COUNT(*) c FROM "${o.name}"`).get();
          if (counted && typeof counted === "object" && "c" in counted
              && typeof counted.c === "number") {
            rows = counted.c;
          }
        } catch {
          // A view over a table that does not exist yet. Report it rather than
          // hiding it, so the gap is visible instead of silently absent.
        }
        return {
          name: o.name,
          kind: o.type,
          ddl: o.sql ?? "",
          // Undocumented objects are listed with a marker rather than omitted;
          // hiding them is how a legacy table becomes a mystery.
          doc: SCHEMA_DOCS[o.name] ?? "(undocumented)",
          rows,
        };
      }),
    };
  } finally {
    db.close();
  }
}
