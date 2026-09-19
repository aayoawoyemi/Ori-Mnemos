import path from "node:path";
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

export async function runSql(
  startDir: string,
  sql: string | undefined,
  options: { limit?: number; timeoutMs?: number; schema?: boolean },
): Promise<SqlCommandResult> {
  let dbPath: string;
  try {
    dbPath = await resolveDbPath(startDir);
  } catch (err: unknown) {
    return {
      success: false,
      data: {},
      warnings: [err instanceof Error ? err.message : String(err)],
    };
  }

  if (options.schema === true) {
    try {
      return { success: true, data: describeSchema(dbPath), warnings: [] };
    } catch (err: unknown) {
      // A missing index is a state, not a crash: say what to run.
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: {},
        warnings: [`no index at ${dbPath}; run \`ori index build\` (${message})`],
      };
    }
  }

  if (sql === undefined || sql.trim() === "") {
    return { success: false, data: {}, warnings: ["no SQL given; pass a query or --schema"] };
  }

  const result: SqlResult = await runReadOnlySql(dbPath, sql, {
    rowCap: options.limit ?? 1000,
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
    warnings: result.warnings,
  };
}
