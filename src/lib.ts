// Library entry point.
//
// This is deliberately NOT src/index.ts. That file is the CLI: it carries a
// shebang and calls program.parse() at module load, so importing it would
// parse your process's argv and run a command. Pointing the package's "."
// export at it would be worse than having no export at all.
//
// The surface below is a contract. Everything reachable from here is subject
// to semver; everything else in src/core is an internal and may move without
// a major bump. Keep this file small for that reason — a barrel that
// re-exports all 25 core modules freezes the entire codebase by accident.

export { VERSION } from "./core/version.js";

// Retrieval, high level. This is the wired entry point the CLI and the MCP
// ori_recall tool both go through: point it at a vault directory and it does
// config load, index sync, embedding, fusion and ranking.
//
// Exported under its own name because the alternative — handing callers
// searchComposite — requires them to assemble storedVectors, graphMetrics,
// vitalityScores, a ClassifiedQuery and an EngineConfig first. An earlier
// draft of this file documented a two-line example against searchComposite
// that had never been run and could not work.
export { runExplore as recall } from "./cli/explore.js";

// Retrieval, low level. Everything above must already be assembled.
export { searchComposite, initDB, embedText } from "./core/engine.js";
export type { ScoredNote } from "./core/ranking.js";
export { rankByImportance, rankByFading, rankByVitality } from "./core/ranking.js";

// Index lifecycle. openSyncedIndex(db, notesDir, expectedNotes) opens the
// index and brings it up to date with the markdown, which is the invariant
// the whole system rests on (the markdown is the truth, the index is derived).
export { openSyncedIndex, syncIndex, loadNoteIndex, loadLinkGraph } from "./core/indexstore.js";

// Read-only SQL over the derived index, and the schema description that
// documents the six stable views.
export { runReadOnlySql, validateReadOnlySql, describeSchema } from "./core/sqlquery.js";

// Query-addressed forgetting. Ori scored 0/1000 on ForgetEval without
// these: every case N/A because the three operations did not exist.
export { supersede, release, purge, matchForForget, FORGOTTEN_STATUSES, ForgetBlastRadiusError } from "./core/forget.js";
export type { ForgetOptions, ForgetMatch, ForgetResult } from "./core/forget.js";

// Configuration.
export { loadConfig } from "./core/config.js";
export type { EngineConfig, RetrievalConfig } from "./core/config.js";
