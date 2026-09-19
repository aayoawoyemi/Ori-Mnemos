import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import { runReadOnlySql, describeSchema, type SqlResult } from "../core/sqlquery.js";

export interface SqlCommandResult {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}

async function resolveDbPath(startDir: string): Promise<string> {
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  return path.resolve(vaultRoot, config.engine.db_path);
}


/** Every path returns this shape, including rejections. A caller that has to
 *  branch on whether `data` has fields cannot write one parser. */
const EMPTY_DATA = { columns: [], rows: [], truncated: false, elapsedMs: 0 };

export async function runSql(
  startDir: string,
  sql: string | undefined,
  options: { limit?: number; timeoutMs?: number; schema?: boolean },
): Promise<SqlCommandResult> {
  const warnings: string[] = [];

  // A row cap that is zero, negative, fractional or NaN silently returned the
  // wrong number of rows and reported "truncated at -3 rows". Clamp, and say
  // so, rather than passing nonsense down to the worker.
  let rowCap = 1000;
  if (options.limit !== undefined) {
    if (!Number.isFinite(options.limit)) {
      warnings.push(`--limit is not a number; using ${rowCap}`);
    } else if (options.limit < 1) {
      warnings.push(`--limit must be at least 1; using 1`);
      rowCap = 1;
    } else {
      const floored = Math.floor(options.limit);
      if (floored !== options.limit) {
        warnings.push(`--limit rounded down to ${floored}`);
      }
      rowCap = floored;
    }
  }

  let dbPath: string;
  try {
    dbPath = await resolveDbPath(startDir);
  } catch (err: unknown) {
    return {
      success: false,
      data: { ...EMPTY_DATA },
      warnings: [...warnings, err instanceof Error ? err.message : String(err)],
    };
  }

  if (options.schema === true) {
    try {
      return { success: true, data: describeSchema(dbPath), warnings };
    } catch (err: unknown) {
      // A missing index is a state, not a crash: say what to run.
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { ...EMPTY_DATA },
        warnings: [...warnings, `no index at ${dbPath}; run \`ori index build\` (${message})`],
      };
    }
  }

  if (sql === undefined || sql.trim() === "") {
    return {
      success: false,
      data: { ...EMPTY_DATA },
      warnings: [...warnings, "no SQL given; pass a query or --schema"],
    };
  }

  // A zero-byte file is not an empty index. SQLite opens one happily and
  // reports no tables, so a truncated or half-copied database answered
  // SELECT 1 with success:true and warnings:[] -- indistinguishable from a
  // real empty vault, which is the one thing spec 9 says must not happen.
  if (existsSync(dbPath) && statSync(dbPath).size === 0) {
    return {
      success: false,
      data: { ...EMPTY_DATA },
      warnings: [
        ...warnings,
        `index at ${dbPath} is zero bytes (truncated or never built); run \`ori index build\``,
      ],
    };
  }

  if (!existsSync(dbPath)) {
    // Reported before the worker runs, so the caller gets an instruction
    // instead of SQLite's "unable to open database file".
    return {
      success: false,
      data: { ...EMPTY_DATA },
      warnings: [...warnings, `no index at ${dbPath}; run \`ori index build\``],
    };
  }

  const result: SqlResult = await runReadOnlySql(dbPath, sql, {
    rowCap,
    timeoutMs: options.timeoutMs ?? 2000,
  });

  // A rejected or failed query is a successful command that returned a
  // problem. Callers distinguish on `success`, which is false only when
  // nothing was produced.
  const failed = result.columns.length === 0 && result.rows.length === 0 && result.warnings.length > 0;

  return {
    success: !failed,
    data: {
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
    },
    warnings: [...warnings, ...result.warnings],
  };
}
