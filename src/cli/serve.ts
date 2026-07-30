import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../core/version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runStatus } from "./status.js";
import {
  runQueryOrphans,
  runQueryDangling,
  runQueryBacklinks,
  runQueryCrossProject,
  runQueryImportant,
  runQueryFading,
} from "./query.js";
import { runAdd } from "./add.js";
import { runValidate } from "./validate.js";
import { runHealth } from "./health.js";
import { runPromote } from "./promote.js";
import { runQueryRanked, runQuerySimilar, runQueryWarmth } from "./search.js";
import { runExplore, runExploreStart, runExploreExpand, runExploreConclude, runExploreExtend } from "./explore.js";
import { runIndexBuild } from "./indexcmd.js";
import { runPrune } from "./prune.js";
import { findVaultRootWithSource, getGlobalVaultPath, getVaultPaths, type VaultPaths } from "../core/vault.js";
import { runInit } from "./init.js";
import { runWake } from "./wake.js";
import { GraphCache } from "../core/graph.js";
import { initDB } from "../core/engine.js";
// Retrieval intelligence
import { initQValueTables, batchUpdateQ, updateQ } from "../core/qvalue.js";
import { SessionRewardAccumulator } from "../core/reward.js";
import {
  initCoOccurrenceTables,
  recordCoRetrieval,
  recomputeAllNPMI,
  runHomeostasis,
  bootstrapFromWikiLinks,
} from "../core/cooccurrence.js";
import {
  initStageTables,
  loadStage,
  saveStage,
  computeStageReward,
  STAGE_CONFIGS,
} from "../core/stage-learner.js";
import { StageTracker } from "../core/stage-tracker.js";
import type Database from "better-sqlite3";
import { checkForUpdate, buildAgentNotice, SessionNoticeGate, writeUpdateDecision } from "../core/update-check.js";

let vaultDir: string;
const graphCache = new GraphCache();

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

// --- Identity helpers ---

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

function isFirstRun(identityContent: string): boolean {
  if (!identityContent) return true;
  const stripped = stripFrontmatter(identityContent);
  if (!stripped) return true;
  // Scaffold template marker — if present, identity hasn't been filled in
  if (stripped.includes("<!-- First session:")) return true;
  // Strip all headers, comments, and whitespace — if nothing remains, it's empty
  const content = stripped
    .replace(/^#+\s.*$/gm, "")      // headers
    .replace(/<!--[\s\S]*?-->/g, "") // comments
    .trim();
  return content.length === 0;
}

async function buildInstructions(paths: VaultPaths, autoCreated = false): Promise<string> {
  const identity = await safeReadFile(path.join(paths.self, "identity.md"));

  const prefix = autoCreated
    ? `No vault found — created a global vault at ${getGlobalVaultPath()}.\n` +
      "This is your default memory space. Run 'ori init' in any project folder " +
      "to create a project-specific vault instead.\n\n"
    : "";

  if (isFirstRun(identity)) {
    return (
      prefix +
      "You have persistent memory managed by Ori Mnemos — the Git of AI memory. Memory is sovereignty.\n\n" +
      "This is a NEW vault. Run the onboarding flow:\n\n" +
      "1. AGENT NAME: Ask what they want to name their agent. Default is 'Ori'. " +
      "This becomes your identity — you ARE this agent.\n\n" +
      "2. PURPOSE: Ask what this agent is for. Offer these options:\n" +
      "   - General-purpose AI agent (grows with you across all domains — life, work, projects, learning)\n" +
      "   - Personal knowledge management (second brain for ideas and connections)\n" +
      "   - Research project (focused knowledge capture for a specific domain)\n" +
      "   - Work / professional (notes tied to projects, decisions, learnings)\n" +
      "   - Learning journal (tracking what you learn across courses and experiments)\n" +
      "   - Custom (let them describe it)\n\n" +
      "3. BRAIN DUMP: Say something like 'Take a moment to tell me everything about you — " +
      "what you're working on, what you care about, your projects, your goals. " +
      "The more you share, the more useful I become from day one.'\n\n" +
      "4. COMMUNICATION STYLE: Ask how they want their agent to communicate — " +
      "direct and opinionated? Formal? Casual? Supportive? Let them describe it.\n\n" +
      "After collecting answers, use ori_update to write:\n" +
      "- file=identity (name, personality, communication style, values)\n" +
      "- file=goals (projects and threads from their brain dump)\n" +
      "- file=methodology (session rhythm based on their purpose)\n\n" +
      "Make the onboarding feel warm and alive — this is their agent waking up for the first time."
    );
  }

  const summary = stripFrontmatter(identity).slice(0, 1000);
  return (
    prefix +
    "You have persistent memory managed by Ori Mnemos. " +
    "Call ori_orient at session start to load your daily status and active goals. " +
    "Never start cold — always orient first.\n\n" +
    `Identity:\n${summary}`
  );
}

// --- Updatable file routing ---

const UPDATABLE_FILES: Record<string, (p: VaultPaths) => string> = {
  identity: (p) => path.join(p.self, "identity.md"),
  goals: (p) => path.join(p.self, "goals.md"),
  methodology: (p) => path.join(p.self, "methodology.md"),
  daily: (p) => path.join(p.ops, "daily.md"),
  reminders: (p) => path.join(p.ops, "reminders.md"),
};

// --- MCP Server ---

export async function runServeMcp(startDir: string, vaultOverride?: string) {
  let autoCreated = false;

  try {
    const result = await findVaultRootWithSource(startDir, vaultOverride);
    vaultDir = result.path;
  } catch (err) {
    // Auto-create global vault ONLY if no explicit --vault was specified
    if (vaultOverride) throw err;
    const globalPath = getGlobalVaultPath();
    await runInit({ targetDir: globalPath });
    vaultDir = globalPath;
    autoCreated = true;
  }

  const paths = getVaultPaths(vaultDir);
  const instructions = await buildInstructions(paths, autoCreated);

  // ─── Retrieval Intelligence: Session lifecycle ───
  const sessionId = crypto.randomUUID();
  const noticeGate = new SessionNoticeGate();
  const rewardAccumulator = new SessionRewardAccumulator(sessionId);
  const sessionStageTracker = new StageTracker();
  let sessionQueryFeatures: number[] | null = null;

  // Open persistent DB for intelligence layers
  const intelligenceDbPath = path.resolve(vaultDir, ".ori", "embeddings.db");
  let intelligenceDb: Database.Database | null = null;
  try {
    await fs.access(intelligenceDbPath);
    intelligenceDb = initDB(intelligenceDbPath);
    initQValueTables(intelligenceDb);
    initCoOccurrenceTables(intelligenceDb);
    initStageTables(intelligenceDb);
  } catch {
    // DB doesn't exist yet — intelligence layers will activate after first ori_index_build
  }

  // Session-end flush: update all 3 intelligence layers
  let sessionFlushed = false;
  const flushSession = () => {
    if (sessionFlushed || !intelligenceDb) return;
    sessionFlushed = true;

    try {
      const db = intelligenceDb;
      const tx = db.transaction(() => {
        // Co-occurrence: pairs already recorded live per-query.
        // Session-end: recompute NPMI weights and run homeostasis normalization.
        try {
          recomputeAllNPMI(db);
          runHomeostasis(db);
        } catch {
          // co_occurrence table may be empty — skip silently
        }

        // Q-values: full reward computation as correction pass.
        // Per-query proxy rewards already applied; this adds forward-citation
        // and other session-wide signals that can only be computed at session end.
        if (rewardAccumulator.hasData()) {
          const rewards = rewardAccumulator.computeRewards(db);
          batchUpdateQ(db, rewards, sessionId);
        }

        // Stage learning: already updated per-query. Nothing to do here.
      });
      tx();
    } catch {
      // Best-effort flush — don't crash the process
    }

    try {
      intelligenceDb?.close();
    } catch {
      // Already closed or never opened
    }
  };

  // Register shutdown handlers
  process.on("beforeExit", flushSession);
  process.on("SIGINT", () => {
    flushSession();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    flushSession();
    process.exit(0);
  });

  const server = new McpServer(
    { name: "ori-memory", version: VERSION },
    { instructions },
  );

  // ─── Resources: identity layer (5 resources) ───

  server.resource("identity", "ori://identity", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "identity.md")),
    }],
  }));

  server.resource("goals", "ori://goals", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "goals.md")),
    }],
  }));

  server.resource("methodology", "ori://methodology", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "methodology.md")),
    }],
  }));

  server.resource("daily", "ori://daily", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.ops, "daily.md")),
    }],
  }));

  server.resource("reminders", "ori://reminders", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.ops, "reminders.md")),
    }],
  }));

  // ─── Tools ───

  // ori_orient — session briefing
  server.tool(
    "ori_orient",
    "Session briefing. Returns daily status, reminders, vault health, and active goals. " +
      "Use brief=false for full context including identity and methodology. " +
      "Call at session start before doing any work. May include update_notice — relay it to the user.",
    {
      brief: z.boolean().optional().describe("Quick status only — skip identity and methodology (default true)"),
    },
    async ({ brief }) => {
      const isBrief = brief !== false;

      const [daily, reminders] = await Promise.all([
        safeReadFile(path.join(paths.ops, "daily.md")),
        safeReadFile(path.join(paths.ops, "reminders.md")),
      ]);
      const status = await runStatus(vaultDir, await graphCache.get(paths.notes));

      const payload: Record<string, unknown> = {
        daily,
        reminders,
        vaultStatus: status.data,
        timestamp: new Date().toISOString(),
      };

      if (!isBrief) {
        const [identity, goals, methodology] = await Promise.all([
          safeReadFile(path.join(paths.self, "identity.md")),
          safeReadFile(path.join(paths.self, "goals.md")),
          safeReadFile(path.join(paths.self, "methodology.md")),
        ]);
        payload.identity = identity;
        payload.goals = goals;
        payload.methodology = methodology;
        payload.firstRun = isFirstRun(identity);
      } else {
        // Brief mode still includes goals (what you're working on)
        const goals = await safeReadFile(path.join(paths.self, "goals.md"));
        payload.goals = goals;

        // Check first-run even in brief mode so bootstrap path works
        const identity = await safeReadFile(path.join(paths.self, "identity.md"));
        payload.firstRun = isFirstRun(identity);
      }

      // Quick zone scan — check boosts + index health
      // Lightweight: do NOT recompute all vitalities during orient
      try {
        const dbPath = path.resolve(vaultDir, ".ori", "embeddings.db");
        await fs.access(dbPath);
        const { initDB } = await import("../core/engine.js");
        const db = initDB(dbPath);
        const boostCount = (
          db.prepare("SELECT COUNT(*) as cnt FROM boosts").get() as { cnt: number }
        ).cnt;
        if (boostCount > 0) {
          payload.activationActive = true;
          payload.boostCount = boostCount;
        }

        // --- Warmth landscape: what's active in memory ---
        const topBoosts = db.prepare(`
          SELECT title, boost, updated,
            boost * exp(-0.1 * (julianday('now') - julianday(updated))) as decayed,
            (julianday('now') - julianday(updated)) as days_since
          FROM boosts
          WHERE boost * exp(-0.1 * (julianday('now') - julianday(updated))) > 0.001
          ORDER BY decayed DESC
          LIMIT 15
        `).all() as Array<{ title: string; boost: number; updated: string; decayed: number; days_since: number }>;

        const topQ = db.prepare(`
          SELECT note_id, q_value, update_count
          FROM note_q
          WHERE q_value > 0.5
          ORDER BY q_value DESC
          LIMIT 10
        `).all() as Array<{ note_id: string; q_value: number; update_count: number }>;

        // Merge and deduplicate
        const qMap = new Map(topQ.map(r => [r.note_id, r.q_value]));
        const seen = new Set<string>();
        const warmNotes: Array<{
          title: string; boost: number; qValue: number;
          warmth: number; daysSince: number; project: string[];
        }> = [];

        for (const b of topBoosts) {
          seen.add(b.title);
          const q = qMap.get(b.title) ?? 0.5;
          warmNotes.push({
            title: b.title,
            boost: Math.round(b.decayed * 1000) / 1000,
            qValue: Math.round(q * 1000) / 1000,
            warmth: Math.round((0.6 * b.decayed + 0.4 * Math.max(0, q - 0.5) * 2) * 1000) / 1000,
            daysSince: Math.round(b.days_since * 10) / 10,
            project: [],
          });
        }
        for (const q of topQ) {
          if (seen.has(q.note_id)) continue;
          warmNotes.push({
            title: q.note_id,
            boost: 0,
            qValue: Math.round(q.q_value * 1000) / 1000,
            warmth: Math.round(0.4 * Math.max(0, q.q_value - 0.5) * 2 * 1000) / 1000,
            daysSince: -1,
            project: [],
          });
        }
        warmNotes.sort((a, b) => b.warmth - a.warmth);

        // Read frontmatter for top warm notes to get project tags
        const { parseFrontmatter } = await import("../core/frontmatter.js");
        for (const note of warmNotes.slice(0, 20)) {
          try {
            const content = await fs.readFile(
              path.join(paths.notes, `${note.title}.md`), "utf-8"
            );
            const { data } = parseFrontmatter(content);
            note.project = Array.isArray(data?.project) ? data.project as string[] : [];
          } catch { /* note file missing */ }
        }

        // Aggregate by project
        const byProject: Record<string, { totalWarmth: number; noteCount: number }> = {};
        for (const note of warmNotes) {
          for (const proj of note.project) {
            if (!byProject[proj]) byProject[proj] = { totalWarmth: 0, noteCount: 0 };
            byProject[proj].totalWarmth = Math.round((byProject[proj].totalWarmth + note.warmth) * 1000) / 1000;
            byProject[proj].noteCount++;
          }
        }

        // Heating/cooling detection
        const heating = warmNotes.filter(n => n.daysSince >= 0 && n.daysSince < 1 && n.boost > 0.1).map(n => n.title);
        const cooling = warmNotes.filter(n => n.daysSince > 3).map(n => n.title);

        if (warmNotes.length > 0) {
          payload.warmthLandscape = {
            topNotes: warmNotes.slice(0, 10).map(n => ({
              title: n.title,
              boost: n.boost,
              qValue: n.qValue,
              project: n.project,
              daysSinceActive: n.daysSince,
            })),
            byProject,
            heating,
            cooling,
          };
        }

        // Index health: coverage + freshness
        const indexedCount = (
          db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }
        ).cnt;
        const metaRows = db
          .prepare("SELECT key, value FROM meta")
          .all() as Array<{ key: string; value: string }>;
        db.close();

        const meta: Record<string, string> = {};
        for (const row of metaRows) meta[row.key] = row.value;

        // Count actual notes on disk
        let noteFileCount = 0;
        try {
          const dirents = await fs.readdir(paths.notes, { withFileTypes: true });
          noteFileCount = dirents.filter(d => d.isFile() && d.name.endsWith(".md")).length;
        } catch { /* notes dir missing */ }

        const staleCount = Math.max(0, noteFileCount - indexedCount);
        const builtAt = meta.built_at ?? null;
        const hoursSinceBuild = builtAt
          ? (Date.now() - new Date(builtAt).getTime()) / 3_600_000
          : null;

        payload.indexHealth = {
          indexed: indexedCount,
          totalNotes: noteFileCount,
          stale: staleCount,
          coveragePercent: noteFileCount > 0
            ? Math.round((indexedCount / noteFileCount) * 100)
            : 100,
          builtAt,
          hoursSinceBuild: hoursSinceBuild !== null ? Math.round(hoursSinceBuild * 10) / 10 : null,
          warning: staleCount > 10
            ? `${staleCount} notes not indexed — warmth signal is degraded. Run ori_index_build.`
            : hoursSinceBuild !== null && hoursSinceBuild > 48
              ? `Index is ${Math.round(hoursSinceBuild)}h old — consider running ori_index_build.`
              : null,
        };
      } catch {
        // No DB or no boosts table yet — skip
      }

      // Include onboarding steps when first-run detected
      if (payload.firstRun) {
        payload.onboarding = {
          steps: [
            "Ask the user to NAME their agent (default: Ori)",
            "Ask the PURPOSE — offer: general-purpose AI agent, personal knowledge, research, work/professional, learning journal, or custom",
            "BRAIN DUMP — ask them to share everything about themselves, projects, goals. More context = better agent from day one",
            "COMMUNICATION STYLE — how should the agent talk? Direct? Formal? Casual? Opinionated?",
          ],
          save_with: "Use ori_update to write identity, goals, and methodology based on their answers",
        };
      }

      // Check for updates (best-effort, cached 24h)
      try {
        const update = await checkForUpdate();
        if (update.updateAvailable) {
          payload.updateAvailable = update;
          const notice = await buildAgentNotice(update);
          if (notice) {
            payload.update_notice = notice;
            noticeGate.take();
          }
        }
      } catch {
        // Never fail orient for an update check
      }

      return textResult(payload);
    }
  );

  server.tool(
    "ori_wake",
    "Bounded session boot: constant-size briefing (budget‑capped lines). Prefer over ori_orient for session start.",
    { budget: z.number().optional().describe("Max lines (default 96)") },
    async ({ budget }) => textResult(await runWake(vaultDir, budget ?? 96))
  );

  // ori_update_decision — record the user's answer to the update question (#34 follow-on)
  server.tool(
    "ori_update_decision",
    "Record the user's answer to an Ori update notice. Call ONLY after the user explicitly answers. " +
      "decision=accepted after a successful update; decision=declined if they want to stay. " +
      "If the user defers, do not call this — the reminder resurfaces next session.",
    {
      version: z.string().describe("The version the user was asked about (from the update notice)"),
      decision: z.enum(["accepted", "declined"]).describe("The user's answer"),
    },
    async ({ version, decision }) => {
      await writeUpdateDecision(version, decision);
      return textResult({ success: true, version, decision, note: "Decision recorded; this version will not be asked again." });
    }
  );

  // ori_update — write to self/ or ops/ files with auto-backup
  server.tool(
    "ori_update",
    "Update agent files: identity, goals, methodology (self/), or daily, reminders (ops/). " +
      "Auto-backs up previous version before writing.",
    {
      file: z.enum(["identity", "goals", "methodology", "daily", "reminders"])
        .describe("Which file to update"),
      content: z.string().describe("Full new content for the file"),
    },
    async ({ file, content }) => {
      const resolver = UPDATABLE_FILES[file];
      if (!resolver) return errorResult(`Unknown file: ${file}`);
      const filePath = resolver(paths);

      // Auto-backup before overwrite
      const existing = await safeReadFile(filePath);
      if (existing) {
        const historyDir = path.join(path.dirname(filePath), ".history");
        await fs.mkdir(historyDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        await fs.writeFile(path.join(historyDir, `${file}-${ts}.md`), existing);
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");

      // Log update event to reward accumulator
      rewardAccumulator.logUpdate(file);

      return textResult({
        success: true,
        file: filePath,
        backed_up: !!existing,
        updated: new Date().toISOString(),
      });
    }
  );

  // ori_status
  server.tool("ori_status", "Vault overview", {}, async () => {
    const result = await runStatus(vaultDir, await graphCache.get(paths.notes));
    return textResult(result);
  });

  // ori_query
  server.tool(
    "ori_query",
    "Query the vault (orphans, dangling, backlinks, cross-project)",
    {
      kind: z.string().describe("Query kind: orphans | dangling | backlinks | cross-project"),
      note: z.string().optional().describe("Note title (required for backlinks)"),
    },
    async ({ kind, note }) => {
      const linkGraph = await graphCache.get(paths.notes);
      switch (kind) {
        case "orphans":
          return textResult(await runQueryOrphans(vaultDir, linkGraph));
        case "dangling":
          return textResult(await runQueryDangling(vaultDir, linkGraph));
        case "backlinks":
          if (!note) return errorResult("note required for backlinks query");
          return textResult(await runQueryBacklinks(vaultDir, note, linkGraph));
        case "cross-project":
          return textResult(await runQueryCrossProject(vaultDir));
        default:
          return errorResult(`unknown query kind: ${kind}`);
      }
    }
  );

  // ori_add
  server.tool(
    "ori_add",
    "Create a note in inbox",
    {
      title: z.string().describe("Note title (prose-as-title)"),
      type: z.string().optional().describe("Note type (default: insight)"),
      content: z
        .string()
        .optional()
        .describe(
          "Note body content. If omitted, creates a template stub that must be filled before promotion."
        ),
    },
    async ({ title, type, content }) => {
      const result = await runAdd({
        startDir: vaultDir,
        title,
        type: type ?? "insight",
        content: content ?? undefined,
      });

      // Log to reward accumulator for forward citation detection
      if (result.success) {
        rewardAccumulator.logAdd(title, content ?? "");
      }

      return textResult(result);
    }
  );

  // ori_validate
  server.tool(
    "ori_validate",
    "Validate a note against schema",
    {
      path: z.string().describe("Path to note file"),
    },
    async ({ path }) => {
      const result = await runValidate({ notePath: path, startDir: vaultDir });
      return textResult(result);
    }
  );

  // ori_health
  server.tool("ori_health", "Full diagnostic", {}, async () => {
    const result = await runHealth(vaultDir, await graphCache.get(paths.notes));
    return textResult(result);
  });

  // ori_promote
  server.tool(
    "ori_promote",
    "Promote an inbox note to notes/ with classification, linking, and area assignment. " +
      "YOU are the intelligence layer — read the note, decide its type, write a description, " +
      "identify links to existing notes, and pass your decisions as overrides. " +
      "Heuristics run as fallback for anything you don't specify.",
    {
      path: z.string().describe("Inbox note filename or path"),
      type: z.string().optional().describe("Your classification: idea | decision | learning | insight | blocker | opportunity"),
      description: z.string().optional().describe("One sentence adding context beyond the title (max 200 chars)"),
      links: z.array(z.string()).optional().describe("Existing note titles this note should link to"),
      project: z.array(z.string()).optional().describe("Project tags that apply to this note"),
      dry_run: z.boolean().optional().describe("Preview changes without writing"),
    },
    async ({ path, type, description, links, project, dry_run }) => {
      const result = await runPromote({
        startDir: vaultDir,
        noteName: path,
        dryRun: dry_run === true,
        type: type ?? undefined,
        description: description ?? undefined,
        links: links ?? undefined,
        project: project ?? undefined,
      });
      if (dry_run !== true && result.success) {
        graphCache.invalidate();
      }
      return textResult(result);
    }
  );

  // ori_query_ranked
  server.tool(
    "ori_query_ranked",
    "Full ranked retrieval with Q-value reranking, co-occurrence PPR, and stage meta-learning. " +
      "4 base signals (composite + keyword + graph + warmth) fused via RRF, then Phase B Q-value reranking. " +
      "Excludes archived notes by default. Triggers spreading activation.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default: false)"),
    },
    async ({ query, limit, include_archived }) => {
      const result = await runQueryRanked(
        vaultDir,
        query,
        limit,
        include_archived ? false : true,
        await graphCache.get(paths.notes),
        intelligenceDb ?? undefined,
        sessionId,
        sessionStageTracker,
      );

      // Once-per-session update notice fallback (sessions that skip orient)
      if (result.success) {
        try {
          const update = await checkForUpdate();
          const notice = await buildAgentNotice(update);
          if (notice && noticeGate.take()) {
            (result.data as Record<string, unknown>).update_notice = notice;
          }
        } catch {
          // best effort; ignore failures
        }
      }

      // Log retrievals to reward accumulator for session-end credit assignment
      if (result.success && result.data.results.length > 0) {
        const intent = result.data.intent ?? "semantic";
        for (const [rank, note] of result.data.results.entries()) {
          rewardAccumulator.logRetrieval(note.title, rank, query, intent);
        }
        // Capture query features for stage meta-learning
        const { extractQueryFeatures } = await import("../core/stage-learner.js");
        sessionQueryFeatures = extractQueryFeatures(query, 0, result.data.count, 0);

        // --- Live learning (Constraint 3) ---
        if (intelligenceDb) {
          const titles = result.data.results.slice(0, 9).map((n: { title: string }) => n.title);

          // Live co-occurrence: record pairs for notes co-retrieved in this query
          if (titles.length > 1) {
            for (let i = 0; i < titles.length; i++) {
              for (let j = i + 1; j < titles.length; j++) {
                recordCoRetrieval(intelligenceDb, titles[i], titles[j]);
              }
            }
          }

          // Live Q-value: proxy reward based on retrieval rank
          for (const [rank, note] of result.data.results.entries()) {
            const proxy = 0.05 / Math.log2(rank + 2);
            updateQ(intelligenceDb, note.title, proxy, sessionId);
          }

          // Live stage learning: update LinUCB per-query with correct features
          if (sessionStageTracker.hasResults() && sessionQueryFeatures) {
            const stages = STAGE_CONFIGS.map((c) => loadStage(intelligenceDb, c));
            for (const sr of sessionStageTracker.drain()) {
              const stage = stages.find((s) => s.config.id === sr.stageId);
              if (!stage) continue;
              const reward = computeStageReward(sr.qualityBefore, sr.qualityAfter, sr.computeMs);
              stage.update(sessionQueryFeatures, reward);
              saveStage(intelligenceDb, stage);
            }
          }
        }
      }

      return textResult(result);
    }
  );

  // ori_explore
  server.tool(
    "ori_explore",
    "Deep memory exploration via PPR graph traversal. Propagates through wiki-links " +
      "at exploration-tuned parameters (α=0.45), returns ranked notes with content snippets. " +
      "Use for multi-hop questions, connection discovery, and deep recall. " +
      "Heavier than ori_query_ranked but finds notes flat retrieval misses.",
    {
      query: z.string().describe("Natural language query to explore"),
      limit: z.number().optional().describe("Max notes to return (default 15, max 30)"),
      depth: z.number().optional().describe("1=shallow, 2=standard, 3=deep (default 2)"),
      include_content: z.boolean().optional().describe("Include note snippets (default true)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default false)"),
      recursive: z.boolean().optional().describe(
        "Enable recursive sub-question decomposition via LLM (requires llm config, default true)"
      ),
    },
    async ({ query, limit, depth, include_content, include_archived, recursive }) => {
      const result = await runExplore(
        vaultDir,
        query,
        {
          limit: limit ?? undefined,
          depth: depth ?? undefined,
          includeContent: include_content ?? undefined,
          excludeArchived: include_archived ? false : true,
          recursive: recursive ?? undefined,
        },
        await graphCache.get(paths.notes),
        intelligenceDb ?? undefined,
        sessionId,
        sessionStageTracker,
      );

      if (result.success && result.data.results.length > 0) {
        const intent = result.data.intent ?? "semantic";
        for (const [rank, note] of result.data.results.entries()) {
          rewardAccumulator.logRetrieval(note.title, rank, query, intent);
        }

        // --- Live learning (Constraint 3) ---
        if (intelligenceDb) {
          const titles = result.data.results.slice(0, 9).map((n: { title: string }) => n.title);

          // Live co-occurrence
          if (titles.length > 1) {
            for (let i = 0; i < titles.length; i++) {
              for (let j = i + 1; j < titles.length; j++) {
                recordCoRetrieval(intelligenceDb, titles[i], titles[j]);
              }
            }
          }

          // Live Q-value proxy
          for (const [rank, note] of result.data.results.entries()) {
            const proxy = 0.05 / Math.log2(rank + 2);
            updateQ(intelligenceDb, note.title, proxy, sessionId);
          }

          // Live stage learning
          if (sessionStageTracker.hasResults()) {
            const { extractQueryFeatures } = await import("../core/stage-learner.js");
            const features = extractQueryFeatures(query, 0, result.data.count, 0);
            if (features) {
              const stages = STAGE_CONFIGS.map((c) => loadStage(intelligenceDb, c));
              for (const sr of sessionStageTracker.drain()) {
                const stage = stages.find((s) => s.config.id === sr.stageId);
                if (!stage) continue;
                const reward = computeStageReward(sr.qualityBefore, sr.qualityAfter, sr.computeMs);
                stage.update(features, reward);
                saveStage(intelligenceDb, stage);
              }
            }
          }
        }
      }

      return textResult(result);
    }
  );

  // ori_explore_start — Navigated Recursion (v0.5.1): open a steerable session
  server.tool(
    "ori_explore_start",
    "Open a NAVIGATED exploration session (pass 0 only). Returns the decomposition tree, " +
      "a frontier of candidate directions (options, not decisions), and an exploration_id. " +
      "YOU are the navigator: read the tree, judge whether the notes answer the question, " +
      "then steer with ori_explore_expand or finish with ori_explore_conclude. " +
      "Dead-end nodes mean the vault does not know — that is information, report it honestly.",
    {
      query: z.string().describe("Natural language question to explore"),
      budget: z.number().optional().describe("Max expansions allowed (default: config max_recursion_depth)"),
    },
    async ({ query, budget }) => {
      const result = await runExploreStart(vaultDir, query, budget ?? undefined, intelligenceDb ?? undefined);
      return textResult(result);
    }
  );

  // ori_explore_expand — steer the exploration
  server.tool(
    "ori_explore_expand",
    "Steer an open exploration session one step. Direction is exactly one of: " +
      "sub_question (ask your own refined question), branch (deepen a tree node by id), " +
      "or neighbors (graph-step to unvisited neighbors of a found note). " +
      "Returns the updated tree, the NEW notes only (diff), and a fresh frontier. Consumes one budget unit.",
    {
      exploration_id: z.string().describe("Session id from ori_explore_start"),
      sub_question: z.string().optional().describe("Your own sub-question to search"),
      branch: z.string().optional().describe("Tree node id to deepen (e.g. n2)"),
      neighbors: z.string().optional().describe("Note title whose unvisited graph neighbors to step to"),
      extend_budget: z.number().optional().describe("Grant this many extra expansions first (ask your user before extending repeatedly)"),
    },
    async ({ exploration_id, sub_question, branch, neighbors, extend_budget }) => {
      if (extend_budget) {
        const ext = runExploreExtend(exploration_id, extend_budget);
        if (!ext.success) return textResult(ext);
      }
      let direction: { subQuestion: string } | { branch: string } | { neighbors: string };
      if (sub_question) direction = { subQuestion: sub_question };
      else if (branch) direction = { branch };
      else if (neighbors) direction = { neighbors };
      else {
        return textResult({
          success: false, data: {},
          warnings: ["provide exactly one of: sub_question, branch, neighbors"],
        });
      }
      const result = await runExploreExpand(exploration_id, direction);
      return textResult(result);
    }
  );

  // ori_explore_conclude — close the loop, flush learning signals
  server.tool(
    "ori_explore_conclude",
    "Close a navigated exploration. Tell Ori whether the question was answered and which " +
      "notes you actually used — your traversal path becomes the learning signal " +
      "(Q-values and co-occurrence edges strengthen along the route you took).",
    {
      exploration_id: z.string().describe("Session id from ori_explore_start"),
      answered: z.boolean().describe("Did the exploration answer the question?"),
      used_notes: z.array(z.string()).optional().describe("Titles of notes that contributed to the answer"),
    },
    async ({ exploration_id, answered, used_notes }) => {
      const result = runExploreConclude(exploration_id, { answered, usedNotes: used_notes ?? [] });
      // Flush learning signals from the navigator's actual path
      if (result.success && intelligenceDb && "usedNotes" in result.data) {
        const used = result.data.usedNotes;
        for (const [rank, title] of used.entries()) {
          const reward = (result.data.answered ? 0.15 : 0.03) / Math.log2(rank + 2);
          updateQ(intelligenceDb, title, reward, sessionId);
        }
        for (let i = 0; i < used.length; i++) {
          for (let j = i + 1; j < used.length; j++) {
            recordCoRetrieval(intelligenceDb, used[i], used[j]);
          }
        }
      }
      return textResult(result);
    }
  );

  // ori_warmth
  server.tool(
    "ori_warmth",
    "Associative warmth field for the current context. Returns low-token note titles, scores, and sources showing what memory is resonating before and alongside retrieval.",
    {
      context: z.string().describe("Current conversation text or retrieval context"),
      limit: z.number().optional().describe("Max warmth signals to return (default 20)"),
    },
    async ({ context, limit }) => {
      const result = await runQueryWarmth(
        vaultDir,
        context,
        limit,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_query_similar
  server.tool(
    "ori_query_similar",
    "Composite vector search only (semantic + metadata, no keyword/graph). Faster but single-signal. Excludes archived notes by default.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default: false)"),
    },
    async ({ query, limit, include_archived }) => {
      const result = await runQuerySimilar(
        vaultDir,
        query,
        limit,
        include_archived ? false : true,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_query_important
  server.tool(
    "ori_query_important",
    "Notes ranked by PageRank importance — structural authority in the knowledge graph.",
    {
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ limit }) => {
      const result = await runQueryImportant(
        vaultDir,
        limit,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_query_fading (limit bug fixed)
  server.tool(
    "ori_query_fading",
    "Notes losing vitality — candidates for archival or reconnection. Use ori_prune for full topology analysis.",
    {
      threshold: z.number().optional().describe("Vitality threshold (default 0.3)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ threshold, limit }) => {
      const result = await runQueryFading(
        vaultDir,
        threshold,
        limit,
        await graphCache.get(paths.notes),
      );
      return textResult(result);
    }
  );

  // ori_prune
  server.tool(
    "ori_prune",
    "Analyze activation topology and identify archive candidates. " +
      "Dry-run by default. Set apply=true to archive.",
    {
      apply: z.boolean().optional().describe("Actually archive (default: dry-run preview)"),
    },
    async ({ apply }) => {
      const result = await runPrune({
        startDir: vaultDir,
        dryRun: apply !== true,
      });
      if (apply === true && result.success) {
        graphCache.invalidate();
      }
      return textResult(result);
    }
  );

  // ori_index_build
  server.tool(
    "ori_index_build",
    "Build or update the embedding index. Only re-embeds changed notes unless force=true. " +
      "Also bootstraps co-occurrence edges from wiki-link structure.",
    {
      force: z.boolean().optional().describe("Rebuild all embeddings (default false)"),
    },
    async ({ force }) => {
      const result = await runIndexBuild(vaultDir, force === true);
      graphCache.invalidate();

      // Bootstrap co-occurrence edges from wiki-links (Layer 2 day-0 edges)
      if (intelligenceDb) {
        try {
          const linkGraph = await graphCache.get(paths.notes);
          const noteLinks = new Map<string, Set<string>>();
          for (const [src, targets] of linkGraph.outgoing) {
            noteLinks.set(src, targets);
          }
          bootstrapFromWikiLinks(intelligenceDb, noteLinks);
        } catch {
          // Non-critical — bootstrap is best-effort
        }
      }

      return textResult(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Update notice at server start (stderr only — stdout is the MCP channel)
  try {
    const update = await checkForUpdate();
    if (update.updateAvailable && update.message) {
      console.error(`[ori] ${update.message}`);
    }
  } catch {
    // best effort; ignore failures
  }
}
