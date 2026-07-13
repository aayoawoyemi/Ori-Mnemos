import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // SQLite (better-sqlite3) holds file handles; the default threads pool
    // makes parallel workers contend for the same temp DBs on Windows
    // (EBUSY family: engine buildIndex cleanup, server ori_warmth,
    // edge-cases DB resilience). Forks isolate the native handles.
    pool: "forks",
    // MCP tests spawn a real server; embedding model load can be slow cold.
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
