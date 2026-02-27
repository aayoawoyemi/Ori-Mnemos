#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./cli/init.js";
import { runStatus } from "./cli/status.js";
import { runHealth } from "./cli/health.js";
import {
  runQueryBacklinks,
  runQueryDangling,
  runQueryOrphans,
  runQueryCrossProject,
  runQueryImportant,
  runQueryFading,
} from "./cli/query.js";
import { runValidate } from "./cli/validate.js";
import { runAdd } from "./cli/add.js";
import { runPromote } from "./cli/promote.js";
import { runArchive } from "./cli/archive.js";
import { runBridgeClaudeCode, runBridgeClaudeCodeGlobal } from "./cli/bridge.js";
import { runServeMcp } from "./cli/serve.js";
import { runQueryRanked, runQuerySimilar } from "./cli/search.js";
import { runIndexBuild, runIndexStatus } from "./cli/indexcmd.js";
import { runGraphMetrics, runGraphCommunities } from "./cli/graphcmd.js";

const program = new Command();

program
  .name("ori")
  .description(
    "Ori Mnemos - markdown-native cognitive harness for persistent agent memory"
  )
  .version("0.3.0");

program
  .command("init")
  .argument("[dir]", "target directory", ".")
  .action(async (dir: string) => {
    const result = await runInit({ targetDir: dir });
    console.log(JSON.stringify({ success: true, data: result, warnings: [] }));
  });

program
  .command("status")
  .action(async () => {
    const result = await runStatus(process.cwd());
    console.log(JSON.stringify(result));
  });

program
  .command("health")
  .action(async () => {
    const result = await runHealth(process.cwd());
    console.log(JSON.stringify(result));
  });

program
  .command("query")
  .argument("<kind>", "orphans | dangling | backlinks | cross-project | ranked | similar | important | fading")
  .argument("[note]", "note title for backlinks, or query text for ranked/similar")
  .option("--limit <n>", "max results", "10")
  .option("--threshold <n>", "vitality threshold for fading", "0.3")
  .action(async (kind: string, note: string | undefined, options: { limit?: string; threshold?: string }) => {
    let result;
    switch (kind) {
      case "orphans":
        result = await runQueryOrphans(process.cwd());
        break;
      case "dangling":
        result = await runQueryDangling(process.cwd());
        break;
      case "backlinks":
        if (!note) {
          throw new Error("backlinks requires a note title");
        }
        result = await runQueryBacklinks(process.cwd(), note);
        break;
      case "cross-project":
        result = await runQueryCrossProject(process.cwd());
        break;
      case "ranked":
        if (!note) {
          throw new Error("ranked requires a query text");
        }
        result = await runQueryRanked(process.cwd(), note);
        break;
      case "similar":
        if (!note) {
          throw new Error("similar requires a query text");
        }
        result = await runQuerySimilar(process.cwd(), note);
        break;
      case "important":
        result = await runQueryImportant(process.cwd(), options.limit ? parseInt(options.limit, 10) : undefined);
        break;
      case "fading":
        result = await runQueryFading(process.cwd(), options.threshold ? parseFloat(options.threshold) : undefined);
        break;
      default:
        throw new Error(`Unknown query kind: ${kind}`);
    }
    console.log(JSON.stringify(result));
  });

program
  .command("validate")
  .argument("<note>", "path to note")
  .action(async (note: string) => {
    const result = await runValidate({ notePath: note });
    console.log(JSON.stringify(result));
  });

program
  .command("add")
  .argument("<title>", "note title")
  .option("-t, --type <type>", "note type", "insight")
  .action(async (title: string, options: { type: string }) => {
    const result = await runAdd({ startDir: process.cwd(), title, type: options.type });
    console.log(JSON.stringify(result));
  });

program
  .command("promote")
  .argument("[note]", "inbox note filename or slug")
  .option("--all", "promote all inbox notes")
  .option("--dry-run", "preview without making changes")
  .option("--no-auto", "skip LLM enhancement even if configured")
  .option("-t, --type <type>", "override type classification")
  .option("-d, --description <desc>", "override description")
  .option("-l, --links <links...>", "additional wiki-links")
  .option("-p, --project <projects...>", "project tags")
  .action(
    async (
      note: string | undefined,
      options: {
        all?: boolean;
        dryRun?: boolean;
        noAuto?: boolean;
        type?: string;
        description?: string;
        links?: string[];
        project?: string[];
      }
    ) => {
      const result = await runPromote({
        startDir: process.cwd(),
        noteName: note,
        all: options.all,
        dryRun: options.dryRun,
        noAuto: options.noAuto,
        type: options.type,
        description: options.description,
        links: options.links,
        project: options.project,
      });
      console.log(JSON.stringify(result));
    }
  );

program
  .command("archive")
  .option("--dry-run", "preview without making changes")
  .action(async (options: { dryRun?: boolean }) => {
    const result = await runArchive({
      startDir: process.cwd(),
      dryRun: options.dryRun,
    });
    console.log(JSON.stringify(result));
  });

program
  .command("bridge")
  .argument("<target>", "claude-code")
  .option("--global", "install hooks to ~/.claude/settings.json (all projects)")
  .action(async (target: string, options: { global?: boolean }) => {
    if (target !== "claude-code") {
      throw new Error(`Unknown bridge target: ${target}`);
    }
    const result = options.global
      ? await runBridgeClaudeCodeGlobal()
      : await runBridgeClaudeCode(process.cwd());
    console.log(JSON.stringify(result));
  });

program
  .command("serve")
  .option("--mcp", "run MCP server")
  .option("--vault <path>", "explicit vault root path")
  .action(async (options: { mcp?: boolean; vault?: string }) => {
    if (!options.mcp) {
      throw new Error("Only MCP server is supported: use --mcp");
    }
    await runServeMcp(options.vault ?? process.cwd());
  });

program
  .command("index")
  .argument("<action>", "build | status")
  .option("--force", "rebuild all embeddings")
  .action(async (action: string, options: { force?: boolean }) => {
    let result;
    switch (action) {
      case "build":
        result = await runIndexBuild(process.cwd(), options.force);
        break;
      case "status":
        result = await runIndexStatus(process.cwd());
        break;
      default:
        throw new Error(`Unknown index action: ${action}`);
    }
    console.log(JSON.stringify(result));
  });

program
  .command("graph")
  .argument("<action>", "metrics | communities")
  .action(async (action: string) => {
    let result;
    switch (action) {
      case "metrics":
        result = await runGraphMetrics(process.cwd());
        break;
      case "communities":
        result = await runGraphCommunities(process.cwd());
        break;
      default:
        throw new Error(`Unknown graph action: ${action}`);
    }
    console.log(JSON.stringify(result));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(String(err));
  process.exit(1);
});
