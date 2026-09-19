/**
 * Worker half of runReadOnlySql. Runs one statement against a connection that
 * cannot write, and posts a JSON-safe result back.
 *
 * This file is the guarantee, not the validator in sqlquery.ts. A parser can
 * be wrong about SQL; `readonly: true` plus `query_only = 1` plus
 * `stmt.readonly` cannot be talked around by clever syntax.
 */


import Database from "better-sqlite3";

interface Input {
  dbPath: string;
  sql: string;
  rowCap: number;
  maxCellBytes: number;
}

// Spawned by fork() with the job in an env var, so the parent can SIGKILL a
// runaway query without taking itself down. A worker thread could not be
// stopped once inside a synchronous SQLite call.
const input = JSON.parse(process.env.ORI_SQL_JOB ?? "{}") as Input;
const send = (m: unknown): void => { process.send?.(m); };

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes, never mid-code-point.
 *
 * The obvious `value.slice(0, maxBytes)` measures UTF-16 code units while the
 * threshold measures UTF-8 bytes. A 4,096-character CJK string is 12,288
 * bytes: it trips the byte check, then slice removes nothing, and the caller
 * gets three times the cap plus a marker announcing a truncation that did not
 * happen. A 1,000-row query of such cells returned 94 MiB with
 * truncated:false. Slicing a Buffer instead fixes the size but can land
 * inside a multi-byte sequence and emit a lone surrogate, which is not
 * encodable UTF-8 -- so the cut is walked back to a boundary.
 */
function cutToBytes(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  // Back off any UTF-8 continuation bytes (10xxxxxx) so the cut is on a
  // code-point boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Make a cell safe to serialise and safe to put in a model's context.
 *
 * The embeddings table holds 1,536-byte float32 blobs, five per row. Returned
 * raw they would be megabytes of noise, so a blob becomes its own description.
 */
function cell(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };

  if (typeof value === "bigint") {
    // The connection runs in safe-integer mode, so every integer arrives as a
    // BigInt. Anything inside the double-safe range goes back as a number so
    // ordinary counts stay numbers; only values JSON would silently corrupt
    // become strings. 9223372036854775807 was being returned as
    // 9223372036854776000 -- off by 193, with no warning.
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { value: Number(value), truncated: false };
    }
    return { value: value.toString(), truncated: false };
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { value: { blob_bytes: value.length }, truncated: false };
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    // JSON has no Infinity or NaN. Name it rather than emitting null, which
    // is indistinguishable from a real NULL.
    return { value: String(value), truncated: false };
  }

  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > maxBytes) {
      return {
        value: cutToBytes(value, maxBytes) + `… [truncated, ${bytes} bytes]`,
        truncated: true,
      };
    }
  }
  return { value, truncated: false };
}

function main(): void {
  if (typeof process.send !== "function") return;

  let db: Database.Database | undefined;
  try {
    db = new Database(input.dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    db.pragma("query_only = 1");

    // Integers arrive as BigInt so a value beyond 2^53 is not silently
    // rounded on the way into JSON. cell() narrows them back to numbers when
    // they fit, so ordinary counts are unaffected.
    db.defaultSafeIntegers(true);

    const stmt = db.prepare(input.sql);

    // The driver's own verdict. Catches a write the prefix rule let through,
    // including a PRAGMA that sets rather than reads.
    if (!stmt.readonly) {
      send({ error: "statement is not read-only" });
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

    let cellsTruncated = 0;
    for (const row of stmt.raw().iterate()) {
      if (rows.length >= input.rowCap) {
        truncated = true;
        break;
      }
      rows.push(
        (row as unknown[]).map((v) => {
          const c = cell(v, input.maxCellBytes);
          if (c.truncated) cellsTruncated++;
          return c.value;
        }),
      );
    }

    if (truncated) {
      warnings.push(`result truncated at ${input.rowCap} rows; add LIMIT or narrow the query`);
    }
    if (cellsTruncated > 0) {
      // Silence here meant a caller could not tell a short value from a cut
      // one without inspecting every cell for the marker.
      warnings.push(
        `${cellsTruncated} cell(s) truncated at ${input.maxCellBytes} bytes`,
      );
    }

    send({ columns, rows, truncated, elapsedMs: 0, warnings });
  } catch (err: unknown) {
    // A malformed query is an answer, not a crash: the caller gets the SQLite
    // message so it can fix the query rather than a stack trace it cannot act on.
    send({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

main();
