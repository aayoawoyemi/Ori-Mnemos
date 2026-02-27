import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
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
import { runQueryRanked, runQuerySimilar } from "./search.js";
import { runIndexBuild } from "./indexcmd.js";
import { getVaultPaths, type VaultPaths } from "../core/vault.js";

let vaultDir: string;

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

async function buildInstructions(paths: VaultPaths): Promise<string> {
  const identity = await safeReadFile(path.join(paths.self, "identity.md"));

  if (isFirstRun(identity)) {
    return (
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

export async function runServeMcp(startDir: string) {
  vaultDir = startDir;
  const paths = getVaultPaths(vaultDir);
  const instructions = await buildInstructions(paths);

  const server = new McpServer(
    { name: "ori-memory", version: "0.3.0" },
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
      "Call at session start before doing any work.",
    {
      brief: z.boolean().optional().describe("Quick status only — skip identity and methodology (default true)"),
    },
    async ({ brief }) => {
      const isBrief = brief !== false;

      const [daily, reminders] = await Promise.all([
        safeReadFile(path.join(paths.ops, "daily.md")),
        safeReadFile(path.join(paths.ops, "reminders.md")),
      ]);
      const status = await runStatus(vaultDir);

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

      return textResult(payload);
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
    const result = await runStatus(vaultDir);
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
      switch (kind) {
        case "orphans":
          return textResult(await runQueryOrphans(vaultDir));
        case "dangling":
          return textResult(await runQueryDangling(vaultDir));
        case "backlinks":
          if (!note) return errorResult("note required for backlinks query");
          return textResult(await runQueryBacklinks(vaultDir, note));
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
      const result = await runValidate({ notePath: path });
      return textResult(result);
    }
  );

  // ori_health
  server.tool("ori_health", "Full diagnostic", {}, async () => {
    const result = await runHealth(vaultDir);
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
      return textResult(result);
    }
  );

  // ori_query_ranked
  server.tool(
    "ori_query_ranked",
    "Full 3-signal engine retrieval (composite + keyword + graph) with intent classification. Returns ranked notes with signal breakdown.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ query, limit }) => {
      const result = await runQueryRanked(vaultDir, query, limit);
      return textResult(result);
    }
  );

  // ori_query_similar
  server.tool(
    "ori_query_similar",
    "Composite vector search only (semantic + metadata, no keyword/graph). Faster but single-signal.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async ({ query, limit }) => {
      const result = await runQuerySimilar(vaultDir, query, limit);
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
      const result = await runQueryImportant(vaultDir, limit);
      return textResult(result);
    }
  );

  // ori_query_fading (limit bug fixed)
  server.tool(
    "ori_query_fading",
    "Notes losing vitality — candidates for archival or reconnection.",
    {
      threshold: z.number().optional().describe("Vitality threshold (default 0.3)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ threshold, limit }) => {
      const result = await runQueryFading(vaultDir, threshold, limit);
      return textResult(result);
    }
  );

  // ori_index_build
  server.tool(
    "ori_index_build",
    "Build or update the embedding index. Only re-embeds changed notes unless force=true.",
    {
      force: z.boolean().optional().describe("Rebuild all embeddings (default false)"),
    },
    async ({ force }) => {
      const result = await runIndexBuild(vaultDir, force === true);
      return textResult(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
