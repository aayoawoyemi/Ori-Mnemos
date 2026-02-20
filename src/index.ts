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
} from "./cli/query.js";
import { runValidate } from "./cli/validate.js";
import { runAdd } from "./cli/add.js";
import { runBridgeClaudeCode, runBridgeClaudeCodeGlobal } from "./cli/bridge.js";
import { runServeMcp } from "./cli/serve.js";

const program = new Command();

program
  .name("ori")
  .description(
    "Ori Mnemos - markdown-native cognitive harness for persistent agent memory"
  )
  .version("0.1.0");

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
  .argument("<kind>", "orphans | dangling | backlinks | cross-project")
  .argument("[note]", "note title for backlinks")
  .action(async (kind: string, note?: string) => {
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
  .action(async (options: { mcp?: boolean }) => {
    if (!options.mcp) {
      throw new Error("Only MCP server is supported: use --mcp");
    }
    await runServeMcp(process.cwd());
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(String(err));
  process.exit(1);
});
