/**
 * Worker half of runReadOnlySql. Runs one statement against a connection that
 * cannot write, and posts a JSON-safe result back.
 *
 * This file is the guarantee, not the validator in sqlquery.ts. A parser can
 * be wrong about SQL; `readonly: true` plus `query_only = 1` plus
 * `stmt.readonly` cannot be talked around by clever syntax.
 */

import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

interface Input {
  dbPath: string;
  sql: string;
  rowCap: number;
  maxCellBytes: number;
}

const input = workerData as Input;

/**
 * Make a cell safe to serialise and safe to put in a model's context.
 *
 * The embeddings table holds 1,536-byte float32 blobs, five per row. Returned
 * raw they would be megabytes of noise, so a blob becomes its own description.
 * BigInt has no JSON representation and would throw during postMessage.
 */
function cell(value: unknown, maxBytes: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { blob_bytes: value.length };
  }
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maxBytes) {
    return value.slice(0, maxBytes) + `… [truncated, ${Buffer.byteLength(value, "utf8")} bytes]`;
  }
  return value;
}

function main(): void {
  if (!parentPort) return;

  let db: Database.Database | undefined;
  try {
    db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    db.pragma("query_only = 1");

    const stmt = db.prepare(input.sql);

    // The driver's own verdict. Catches a write the prefix rule let through,
    // including a PRAGMA that sets rather than reads.
    if (!stmt.readonly) {
      parentPort.postMessage({ error: "statement is not read-only" });
      return;
    }

    const warnings: string[] = [];
    const rows: unknown[][] = [];
    let truncated = false;

    // .raw() yields arrays instead of objects: no per-row object allocation,
    // and duplicate column names survive instead of colliding on one key.
    // EXPLAIN and some pragma-shaped statements return no columns at all, in
    // which case iterate() still works but columns() throws.
    let columns: string[] = [];
    try {
      columns = stmt.columns().map((c) => c.name);
    } catch {
      warnings.push("statement exposes no column metadata");
    }

    for (const row of stmt.raw().iterate()) {
      if (rows.length >= input.rowCap) {
        truncated = true;
        break;
      }
      rows.push((row as unknown[]).map((v) => cell(v, input.maxCellBytes)));
    }

    if (truncated) {
      warnings.push(`result truncated at ${input.rowCap} rows; add LIMIT or narrow the query`);
    }

    parentPort.postMessage({ columns, rows, truncated, elapsedMs: 0, warnings });
  } catch (err: unknown) {
    // A malformed query is an answer, not a crash: the caller gets the SQLite
    // message so it can fix the query rather than a stack trace it cannot act on.
    parentPort.postMessage({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

main();
