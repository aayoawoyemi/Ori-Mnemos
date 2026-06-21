/**
 * Ori CLI display layer — Parchment Edition
 *
 * Warm terminal output for humans. JSON stays for MCP/pipes.
 * Gold frames content (headers only). Cream is everything else.
 * No cold colors. The warmest terminal you've ever seen.
 */

import chalk from "chalk";

// ============================================================
// SECTION 1: TTY GATE + PALETTE
// ============================================================

export const isTTY = Boolean(process.stdout.isTTY);

const cream = chalk.ansi256(230);   // #ffffd7 — default text
const gold = chalk.ansi256(178);    // #d7af00 — headers only
const dim = chalk.ansi256(137);     // #af8747 — labels, secondary
const gray = chalk.ansi256(242);    // #6c6c6c — decorators, ranks
const green = chalk.ansi256(107);   // #87af5f — success only
const red = chalk.ansi256(173);     // #d7875f — errors only

// ============================================================
// SECTION 2: LAYOUT PRIMITIVES (private)
// ============================================================

function nl(): void {
  console.log();
}

function header(text: string): void {
  console.log(`  ${gold(text)}`);
}

function headerWithValue(label: string, value: string): void {
  console.log(`  ${gold(label)}  ${cream(value)}`);
}

function subline(...parts: string[]): void {
  console.log(`  ${dim(parts.join("   "))}`);
}

function row(label: string, value: string | number): void {
  console.log(`  ${cream(String(value))} ${dim(label)}`);
}

function inlineStats(pairs: Array<[string | number, string]>): void {
  const parts = pairs.map(([val, label]) => `${cream(String(val))} ${dim(label)}`);
  console.log(`  ${parts.join("   ")}`);
}

function listItem(text: string): void {
  console.log(`    ${cream(text)}`);
}

function dimListItem(text: string): void {
  console.log(`    ${dim(text)}`);
}

function dimLine(text: string): void {
  console.log(`  ${dim(text)}`);
}

function warn(text: string): void {
  console.log(`  ${gold("!")} ${cream(text)}`);
}

function err(text: string): void {
  console.log(`  ${red("x")} ${cream(text)}`);
}

function success(text: string): void {
  console.log(`  ${green(text)}`);
}

// ============================================================
// SECTION 3: SHARED RENDERERS (private)
// ============================================================

function renderWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  nl();
  for (const w of warnings) {
    warn(w);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function renderRankedList(
  items: Array<{ title: string; score: number; extra?: string }>,
  opts?: { max?: number },
): void {
  const max = opts?.max ?? items.length;
  const shown = items.slice(0, max);
  if (shown.length === 0) return;

  const maxTitle = Math.min(
    Math.max(...shown.map((i) => i.title.length)),
    52,
  );

  for (let i = 0; i < shown.length; i++) {
    const rank = String(i + 1).padStart(3);
    const title = truncate(shown[i].title, maxTitle).padEnd(maxTitle);
    const score = shown[i].score.toFixed(shown[i].score < 0.1 ? 4 : 3);
    const extra = shown[i].extra ? `  ${dim(shown[i].extra)}` : "";
    console.log(`  ${gray(rank)}  ${cream(title)}  ${dim(score)}${extra}`);
  }

  if (items.length > max) {
    dimLine(`... ${items.length - max} more`);
  }
}

function renderNoteList(
  notes: string[],
  opts?: { max?: number },
): void {
  const max = opts?.max ?? 10;
  const shown = notes.slice(0, max);
  for (const note of shown) {
    listItem(note);
  }
  if (notes.length > max) {
    dimLine(`... ${notes.length - max} more`);
  }
}

// ============================================================
// SECTION 4: COMMAND DISPLAY FUNCTIONS (exported)
// ============================================================

// --- ori status ---

export function displayStatus(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    vaultRoot: string;
    noteCount: number;
    inboxCount: number;
    orphanCount: number;
  };

  nl();
  header("Vault");
  nl();
  dimLine(d.vaultRoot);
  inlineStats([
    [d.noteCount, "notes"],
    [d.inboxCount, "inbox"],
    [d.orphanCount, "orphans"],
  ]);
  renderWarnings(result.warnings);
  nl();
}

// --- ori health ---

export function displayHealth(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    noteCount: number;
    orphanCount: number;
    danglingCount: number;
    orphans: string[];
    dangling: Array<{ from: string; to: string }>;
    schemaViolations: Array<{ note: string; errors: string[] }>;
    fading: Array<{ note: string; vitality: number }>;
  };

  nl();
  header("Health");
  nl();
  inlineStats([
    [d.noteCount, "notes"],
    [d.orphanCount, "orphans"],
    [d.danglingCount, "dangling"],
    [d.fading.length, "fading"],
  ]);

  if (d.orphans.length > 0) {
    nl();
    console.log(`  ${gold("Orphans")} ${dim(`(${d.orphans.length})`)}`);
    renderNoteList(d.orphans);
  }

  if (d.dangling.length > 0) {
    nl();
    console.log(`  ${gold("Dangling Links")} ${dim(`(${d.dangling.length})`)}`);
    for (const link of d.dangling.slice(0, 10)) {
      console.log(`    ${cream(link.from)} ${dim("→")} ${cream(link.to)}`);
    }
    if (d.dangling.length > 10) {
      dimLine(`... ${d.dangling.length - 10} more`);
    }
  }

  if (d.schemaViolations.length > 0) {
    nl();
    console.log(`  ${gold("Schema Violations")} ${dim(`(${d.schemaViolations.length})`)}`);
    for (const v of d.schemaViolations.slice(0, 5)) {
      listItem(v.note);
      for (const e of v.errors.slice(0, 3)) {
        console.log(`      ${dim(e)}`);
      }
    }
    if (d.schemaViolations.length > 5) {
      dimLine(`... ${d.schemaViolations.length - 5} more`);
    }
  }

  if (d.fading.length > 0) {
    nl();
    console.log(`  ${gold("Fading")} ${dim(`(${d.fading.length})`)}`);
    const maxTitle = Math.min(
      Math.max(...d.fading.slice(0, 10).map((f) => f.note.length)),
      52,
    );
    for (const f of d.fading.slice(0, 10)) {
      const title = truncate(f.note, maxTitle).padEnd(maxTitle);
      const vit = (f.vitality * 100).toFixed(0);
      console.log(`    ${cream(title)}  ${dim(`vitality ${f.vitality.toFixed(2)}`)}`);
    }
    if (d.fading.length > 10) {
      dimLine(`... ${d.fading.length - 10} more`);
    }
  }

  renderWarnings(result.warnings);
  nl();
}

// --- ori query orphans ---

export function displayQueryOrphans(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as { orphans: string[] };

  nl();
  console.log(`  ${gold("Orphans")} ${dim(`(${d.orphans.length})`)}`);
  if (d.orphans.length === 0) {
    dimLine("none");
  } else {
    renderNoteList(d.orphans, { max: 20 });
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query dangling ---

export function displayQueryDangling(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as { dangling: Array<{ from: string; to: string }> };

  nl();
  console.log(`  ${gold("Dangling Links")} ${dim(`(${d.dangling.length})`)}`);
  if (d.dangling.length === 0) {
    dimLine("none");
  } else {
    for (const link of d.dangling.slice(0, 20)) {
      console.log(`    ${cream(link.from)} ${dim("→")} ${cream(link.to)}`);
    }
    if (d.dangling.length > 20) {
      dimLine(`... ${d.dangling.length - 20} more`);
    }
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query backlinks ---

export function displayQueryBacklinks(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as { backlinks: string[] };

  nl();
  console.log(`  ${gold("Backlinks")} ${dim(`(${d.backlinks.length})`)}`);
  if (d.backlinks.length === 0) {
    dimLine("none");
  } else {
    renderNoteList(d.backlinks, { max: 20 });
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query cross-project ---

export function displayQueryCrossProject(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as { notes: string[] };

  nl();
  console.log(`  ${gold("Cross-Project Notes")} ${dim(`(${d.notes.length})`)}`);
  if (d.notes.length === 0) {
    dimLine("none");
  } else {
    renderNoteList(d.notes, { max: 20 });
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query important ---

export function displayQueryImportant(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    results: Array<{ title: string; score: number }>;
  };

  nl();
  header("Important");
  nl();
  if (d.results.length === 0) {
    dimLine("no results");
  } else {
    renderRankedList(d.results);
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query fading ---

export function displayQueryFading(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    results: Array<{ title: string; score: number }>;
  };

  nl();
  header("Fading");
  nl();
  if (d.results.length === 0) {
    dimLine("no fading notes");
  } else {
    renderRankedList(d.results);
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query ranked ---

type ScoredNoteDisplay = {
  title: string;
  score: number;
  signals: Record<string, number | undefined>;
};

export function displayQueryRanked(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    query: string;
    intent: string;
    results: ScoredNoteDisplay[];
    count: number;
  };

  nl();
  headerWithValue("Query", d.query);
  subline(`Intent  ${d.intent}`);
  nl();
  if (d.results.length === 0) {
    dimLine("no results");
  } else {
    renderRankedList(d.results.map((r) => ({ title: r.title, score: r.score })));
    nl();
    dimLine(`${d.count} results`);
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query similar (reuses ranked renderer) ---

export function displayQuerySimilar(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    query: string;
    intent: string;
    results: ScoredNoteDisplay[];
    count: number;
  };

  nl();
  headerWithValue("Similar", d.query);
  subline(`Intent  ${d.intent}`);
  nl();
  if (d.results.length === 0) {
    dimLine("no results");
  } else {
    renderRankedList(d.results.map((r) => ({ title: r.title, score: r.score })));
    nl();
    dimLine(`${d.count} results`);
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori query warmth-audit ---

export function displayQueryWarmthAudit(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    entries?: Array<{
      timestamp: string;
      query: string;
      event: string;
    }>;
    count?: number;
  };

  nl();
  header("Warmth Audit");
  nl();
  const entries = d.entries ?? [];
  if (entries.length === 0) {
    dimLine("no audit entries");
  } else {
    for (const entry of entries.slice(0, 15)) {
      console.log(`    ${dim(entry.timestamp)}  ${cream(entry.query)}`);
      console.log(`      ${dim(entry.event)}`);
    }
    if (entries.length > 15) {
      dimLine(`... ${entries.length - 15} more`);
    }
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori validate ---

export function displayValidate(result: {
  success: boolean;
  errors: string[];
  warnings: string[];
}): void {
  nl();
  if (result.success && result.errors.length === 0 && result.warnings.length === 0) {
    success("valid");
  } else {
    for (const w of result.warnings) {
      warn(w);
    }
    for (const e of result.errors) {
      err(e);
    }
  }
  nl();
}

// --- ori add ---

export function displayAdd(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  nl();
  if (!result.success) {
    const d = result.data as { reason?: string };
    err(d.reason ?? "failed to add note");
    renderWarnings(result.warnings);
    nl();
    return;
  }

  const d = result.data as { path: string; autoPromoted?: boolean };
  header(d.autoPromoted ? "Added + Promoted" : "Added");
  dimLine(d.path);
  renderWarnings(result.warnings);
  nl();
}

// --- ori promote ---

export function displayPromote(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    promoted: Array<{
      from: string;
      to: string;
      changes: string[];
      warnings: string[];
    }>;
    skipped: Array<{ path: string; reason: string }>;
  };

  nl();
  if (d.promoted.length > 0) {
    console.log(`  ${gold("Promoted")} ${dim(`(${d.promoted.length})`)}`);
    nl();
    for (const p of d.promoted) {
      const name = p.to.split(/[/\\]/).pop() ?? p.to;
      listItem(name.replace(/\.md$/, ""));
      console.log(`      ${dim(`${p.from.split(/[/\\]/).pop()} → ${name}`)}`);
      for (const c of p.changes) {
        console.log(`      ${dim(c)}`);
      }
      for (const w of p.warnings) {
        console.log(`      ${gold("!")} ${dim(w)}`);
      }
      nl();
    }
  }

  if (d.skipped.length > 0) {
    console.log(`  ${gold("Skipped")} ${dim(`(${d.skipped.length})`)}`);
    for (const s of d.skipped) {
      const name = s.path.split(/[/\\]/).pop() ?? s.path;
      dimListItem(`${name} — ${s.reason}`);
    }
    nl();
  }

  renderWarnings(result.warnings);
  if (d.promoted.length === 0 && d.skipped.length === 0) {
    dimLine("nothing to promote");
    nl();
  }
}

// --- ori archive ---

export function displayArchive(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    archived: Array<{
      note: string;
      reason: string;
      daysSinceAccess: number;
      incomingLinks: number;
    }>;
  };

  nl();
  console.log(`  ${gold("Archived")} ${dim(`(${d.archived.length})`)}`);
  if (d.archived.length === 0) {
    dimLine("nothing to archive");
  } else {
    nl();
    for (const a of d.archived.slice(0, 15)) {
      listItem(a.note);
      console.log(`      ${dim(`${a.daysSinceAccess}d since access, ${a.incomingLinks} incoming — ${a.reason}`)}`);
    }
    if (d.archived.length > 15) {
      dimLine(`... ${d.archived.length - 15} more`);
    }
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori index build ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function displayIndexBuild(result: {
  success: boolean;
  data: any;
  warnings: string[];
}): void {
  const d = result.data as {
    indexed: number;
    skipped: number;
    total: number;
    durationMs: number;
    model: string;
  };

  nl();
  const seconds = (d.durationMs / 1000).toFixed(1);
  console.log(`  ${gold("Indexed")} ${cream(`${d.indexed} notes`)} ${dim(`(${d.skipped} skipped) in ${seconds}s`)}`);
  dimLine(`Model  ${d.model}`);
  renderWarnings(result.warnings);
  nl();
}

// --- ori index status ---

export function displayIndexStatus(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    exists: boolean;
    noteCount: number;
    model: string;
    dbPath: string;
    dbSizeBytes: number;
    meta?: Record<string, string>;
  };

  nl();
  header("Index");
  nl();
  if (!d.exists) {
    warn("Index not built — run ori index build");
  } else {
    const sizeKb = (d.dbSizeBytes / 1024).toFixed(0);
    const sizeMb = (d.dbSizeBytes / (1024 * 1024)).toFixed(1);
    const size = d.dbSizeBytes > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
    inlineStats([
      [d.noteCount, "notes indexed"],
      [size, ""],
    ]);
    dimLine(`Model  ${d.model}`);
    dimLine(d.dbPath);
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori graph metrics ---

export function displayGraphMetrics(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    bridgeCount: number;
    topPageRank: Array<{ title: string; score: number }>;
    topBetweenness: Array<{ title: string; score: number }>;
  };

  nl();
  header("Graph");
  nl();
  inlineStats([
    [d.nodeCount, "nodes"],
    [d.edgeCount, "edges"],
    [d.communityCount, "communities"],
    [d.bridgeCount, "bridges"],
  ]);

  if (d.topPageRank.length > 0) {
    nl();
    console.log(`  ${gold("Top by PageRank")}`);
    renderRankedList(d.topPageRank, { max: 10 });
  }

  if (d.topBetweenness.length > 0) {
    nl();
    console.log(`  ${gold("Top by Betweenness")}`);
    renderRankedList(d.topBetweenness, { max: 10 });
  }

  renderWarnings(result.warnings);
  nl();
}

// --- ori graph communities ---

export function displayGraphCommunities(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    communities: Array<{
      id: number;
      size: number;
      members: string[];
    }>;
  };

  nl();
  header("Communities");
  nl();
  if (d.communities.length === 0) {
    dimLine("no communities detected");
  } else {
    for (const c of d.communities.slice(0, 10)) {
      const preview = c.members.slice(0, 3).join(", ");
      const more = c.members.length > 3 ? ` ... ${c.members.length - 3} more` : "";
      console.log(`  ${cream(`Community ${c.id}`)}  ${dim(`${c.size} notes`)}`);
      console.log(`    ${dim(preview + more)}`);
    }
    if (d.communities.length > 10) {
      nl();
      dimLine(`... ${d.communities.length - 10} more communities`);
    }
  }
  renderWarnings(result.warnings);
  nl();
}

// --- ori prune ---

export function displayPrune(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    zones: { active: number; stale: number; fading: number; archived: number };
    total: number;
    articulationPoints: string[];
    candidates: Array<{
      title: string;
      vitality: number;
      zone: string;
      reason: string;
      inDegree: number;
    }>;
    applied: boolean;
    archivedCount: number;
    hotspots: Array<{
      community: number;
      size: number;
      meanVitality: number;
      topMembers: string[];
    }>;
  };

  nl();
  headerWithValue("Prune", d.applied ? "applied" : "dry run");
  nl();
  inlineStats([
    [d.total, "notes"],
    [`active ${d.zones.active}`, ""],
    [`stale ${d.zones.stale}`, ""],
    [`fading ${d.zones.fading}`, ""],
    [`archived ${d.zones.archived}`, ""],
  ]);
  dimLine(`${d.articulationPoints.length} articulation points protected`);

  if (d.candidates.length > 0) {
    nl();
    console.log(`  ${gold("Candidates")} ${dim(`(${d.candidates.length})`)}`);
    const maxTitle = Math.min(
      Math.max(...d.candidates.slice(0, 15).map((c) => c.title.length)),
      44,
    );
    for (const c of d.candidates.slice(0, 15)) {
      const title = truncate(c.title, maxTitle).padEnd(maxTitle);
      console.log(`    ${cream(title)}  ${dim(`${c.zone}   vitality ${c.vitality.toFixed(2)}   ${c.inDegree} incoming`)}`);
    }
    if (d.candidates.length > 15) {
      dimLine(`... ${d.candidates.length - 15} more`);
    }
  }

  if (d.hotspots.length > 0) {
    nl();
    console.log(`  ${gold("Hotspots")}`);
    for (const h of d.hotspots.slice(0, 5)) {
      console.log(`  ${cream(`Community ${h.community}`)}  ${dim(`${h.size} notes   mean vitality ${h.meanVitality.toFixed(2)}`)}`);
      console.log(`    ${dim(h.topMembers.join(", "))}`);
    }
  }

  if (!d.applied && d.candidates.length > 0) {
    nl();
    dimLine(`Run with --apply to archive ${d.candidates.length} notes.`);
  }

  if (d.applied) {
    nl();
    console.log(`  ${green(`Archived ${d.archivedCount} notes.`)}`);
  }

  renderWarnings(result.warnings);
  nl();
}

// --- ori explore ---

type ExploreNoteDisplay = {
  title: string;
  score: number;
  pprScore: number;
  seedScore: number | null;
  warmthScore: number | null;
  source: "seed" | "ppr" | "warmth" | "multi";
};

type ExplorePathDisplay = {
  from: string;
  to: string;
  via: string[];
};

export function displayExplore(result: {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}): void {
  const d = result.data as {
    query: string;
    intent: string;
    results: ExploreNoteDisplay[];
    paths: ExplorePathDisplay[];
    count: number;
    seed_count: number;
    depth: number;
    elapsed_ms: number;
  };

  nl();
  headerWithValue("Explore", d.query);
  subline(`Intent  ${d.intent}   depth ${d.depth}   ${d.count} results in ${d.elapsed_ms}ms`);

  // Split results by source
  const seeds = d.results.filter((r) => r.source === "seed");
  const discovered = d.results.filter((r) => r.source !== "seed");

  if (seeds.length > 0) {
    nl();
    console.log(`  ${gold("Seeds")} ${dim(`(${seeds.length})`)}`);
    renderRankedList(
      seeds.map((r) => ({ title: r.title, score: r.score, extra: r.source })),
    );
  }

  if (discovered.length > 0) {
    nl();
    console.log(`  ${gold("Discovered")} ${dim(`(${discovered.length})`)}`);
    renderRankedList(
      discovered.map((r) => ({ title: r.title, score: r.score, extra: r.source })),
    );
  }

  if (d.paths.length > 0) {
    nl();
    console.log(`  ${gold("Paths")}`);
    for (const p of d.paths.slice(0, 5)) {
      listItem(p.from);
      for (const v of p.via) {
        console.log(`      ${dim("via")}  ${cream(v)}`);
      }
      console.log(`      ${dim("to")}   ${cream(p.to)}`);
    }
    if (d.paths.length > 5) {
      dimLine(`... ${d.paths.length - 5} more paths`);
    }
  }

  renderWarnings(result.warnings);
  nl();
}
