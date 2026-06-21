import chalk from "chalk";
import figlet from "figlet";
import * as p from "@clack/prompts";
import os from "node:os";
import path from "node:path";
import { writeState } from "../core/state.js";
import { runInit, type InitResult } from "./init.js";
// screen.ts is available for future interactive TUI modes
// import { enterParchment, exitParchment } from "./screen.js";

// Colors: antique gold for title, warm parchment for elephant
const gold = chalk.ansi256(178);
const parchment = chalk.ansi256(230);
const dim = chalk.ansi256(245);

// Elephant braille art (generated from elephant.png via ascii-image-converter -b -n -W 60)
// Trimmed: empty braille lines removed from top/bottom
const ELEPHANT = `⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⠤⠤⠶⠒⠒⠒⠶⠦⠤⠤⠤⠤⣀⠀⠀⣀⣠⡤⠤⠤⠤⠤⣄⣀⣀⠀⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠄⠚⡛⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠯⣍⠉⠉⠙⠢⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⣠⠞⠁⠀⠀⠀⠀⠀⠀⠰⣤⣄⠀⠐⠳⠖⠋⠛⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣌⠻⣷⢀⡀⠙⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⢀⡞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠙⢺⣿⣷⡐⣴⠃⢀⣦⠂⠀⠀⠀⠀⡠⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣆⢻⣾⣷⠂⠈⢆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⣠⠟⠁⠠⠤⠀⠀⠀⠀⠀⠀⠀⠀⠀⠨⣿⣿⣾⡿⠿⠃⢀⡀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠺⣿⠋⠀⠀⠘⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⡞⣡⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⣿⣿⢠⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢳⡀⠀⠀⠹⡄⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠘⡧⠋⣰⠎⠀⠐⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣾⡟⠀⠀⠀⠀⢀⣴⢦⣠⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣤⡇⠀⠀⢡⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠹⣾⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⡁⡀⡜⠀⠀⢺⣶⣶⣾⡿⠆⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⢸⣷⠇⠀⠠⠘⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢿⠀⠀⠀⠀⠀⢀⡔⠁⠀⠀⠀⠀⠀⠀⠀⠀⣿⣧⣧⣿⡄⠀⠀⢙⠿⣫⠃⠘⠱⡠⡀⠀⠀⠀⠀⠀⠀⠀⣠⢸⣿⠀⠠⠠⠘⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠘⣦⡗⣠⠂⠠⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⢹⣿⠛⠿⠒⠤⣤⣭⣽⠄⠀⠀⠀⠱⡠⠐⠀⠈⠉⠀⠄⣨⢸⣇⠀⢘⣇⢧⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠈⠙⣆⣠⠂⢠⠀⢠⠃⠀⠀⠀⠀⠀⠀⠀⠈⣾⣿⡄⠀⠠⡀⠀⠘⣿⠀⠀⠀⠀⠀⠀⠁⡀⠤⠤⠤⠤⢬⡀⣿⡇⠀⣿⡼⠁⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠳⣇⣰⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⢻⣟⠀⣴⣜⠔⠞⣻⠀⠀⠀⠀⠀⠐⠁⠀⢀⣀⣀⣀⡀⠄⠘⣿⣇⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣇⠀⢸⠀⠀⠀⠀⠀⠀⠀⢸⡏⣿⣜⣿⣏⠳⣾⣿⠀⠀⠀⢠⠀⠀⠀⠊⠁⠀⠀⠀⠈⠑⢠⠸⡿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⣸⣷⣮⣀⠀⠀⠀⠀⠀⠀⠈⡁⣿⣿⣿⣟⣳⡾⣿⣀⣤⣄⡀⢧⠠⠀⠠⠐⠒⠐⠒⠒⠢⣸⣇⡷⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡏⡏⣿⣧⡝⣿⣦⣀⡀⠀⡀⠀⠇⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⢻⣾⣴⠂⠀⠠⠤⠐⠂⠤⢄⣸⣿⠹⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡇⣿⣿⡇⠨⡻⢿⣿⣷⣤⣤⣼⣿⣯⣻⣿⣿⣿⣿⣿⣷⠀⠀⣿⣯⢿⡀⠀⠠⠄⠂⠤⠄⡿⢻⣇⠘⢆⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⢰⢸⣿⣷⠀⠀⡪⣿⣿⣿⣿⣿⣿⡿⣮⣯⣻⣿⣿⣿⣿⣷⡀⠘⢿⣏⡆⠀⠐⠒⠒⠒⠲⡇⠀⠙⠦⣀⠣⡀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠈⢹⣿⡀⠀⠔⠉⠠⠈⠉⠁⠘⣷⣬⣻⣇⣻⡹⣿⣿⣿⣿⣶⣬⣿⠵⠀⢈⣉⣉⣉⣙⡇⠀⠀⠀⠈⠙⠁⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⡇⠀⠀⠠⠀⠁⠀⠀⢀⣻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡞⠁⠠⠤⠤⠤⢼⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⠀⡀⠀⠀⠀⠀⣀⠀⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇⠀⠀⠈⢉⣉⣹⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⡆⣷⠀⠀⠀⠈⠀⠀⠀⠈⡙⢿⣿⣿⡿⢻⣿⣿⣿⣿⣿⡇⠀⠀⠀⠠⠤⢼⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠳⠘⠀⠀⠀⠀⠀⠀⠀⠀⠈⢸⡟⠉⠀⠀⣿⣿⠿⠃⠀⣷⠀⠀⠀⠀⠀⢽⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡇⠀⠀⠀⢿⠉⠀⠀⠀⢹⠀⠀⠀⠀⠈⣻⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠁⠀⠀⠀⠀⠀⠀⠀⠀⢸⠆⠀⠀⠀⠀⢾⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢨⡇⠀⠀⠀⠂⣺⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣇⠀⠀⠀⡀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣀⡏⠀⠀⣠⣄⡏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⡏⣴⣿⠃⠀⣠⣿⣾⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢷⣦⣁⣤⣼⣿⡿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠛⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀`;

// MCP config snippets for each client
const MCP_CONFIGS: Record<string, { file: string; snippet: string }> = {
  "Claude Code": {
    file: ".claude/settings.json (in your project or ~/.claude/settings.json globally)",
    snippet: `Recommended:
ori bridge claude-code --scope global --activation auto --vault /path/to/brain`,
  },
  Cursor: {
    file: ".cursor/mcp.json (in your project root)",
    snippet: `Recommended:
ori bridge cursor --scope project --activation manual --vault /path/to/brain`,
  },
  Other: {
    file: "your MCP client's config file",
    snippet: `Print install plan:
ori bridge generic --scope global --activation manual --vault /path/to/brain

Transport: stdio (JSON-RPC 2.0)`,
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateTitle(): string {
  return figlet.textSync("ORI MNEMOS", { font: "Standard" });
}

export async function runBootSequence(initResult: InitResult, targetDir: string): Promise<void> {
  // Clear screen
  process.stdout.write("\x1b[2J\x1b[H");

  // Print title in antique gold, line by line
  const titleLines = generateTitle().split("\n");
  for (const line of titleLines) {
    console.log(gold(line));
    await sleep(80);
  }
  await sleep(300);

  // Print elephant in warm parchment, line by line (slow reveal)
  const elephantLines = ELEPHANT.split("\n");
  for (let i = 0; i < elephantLines.length; i++) {
    console.log(parchment(elephantLines[i]));
    // Start slow, speed up in the middle, slow down at the end (easing)
    const progress = i / elephantLines.length;
    const eased = progress < 0.3 ? 120 : progress > 0.7 ? 120 : 70;
    await sleep(eased);
  }
  await sleep(400);

  // "Memory is Sovereignty" box
  p.note(gold("Memory is Sovereignty."));
  console.log();

  // Loading spinner
  const s = p.spinner();
  s.start("Initializing vault...");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  s.stop("Vault initialized");

  // Welcome + setup choice
  const mode = await p.select({
    message: "Welcome. Your memory starts here.",
    options: [
      { value: "guided", label: "Walk me through setup" },
      { value: "skip", label: "Skip — I know what I'm doing" },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel("Setup cancelled.");
    await writeState(targetDir, { onboarded: true, version: getVersion() });
    return;
  }

  if (mode === "skip") {
    const resolvedDir = path.resolve(targetDir);
    p.outro(`Vault created at ${dim(resolvedDir)}. Run ${gold("ori bridge claude-code --scope global --activation auto --vault " + resolvedDir)} or ${gold("ori bridge generic --scope global --activation manual --vault " + resolvedDir)}.`);
    await writeState(targetDir, { onboarded: true, version: getVersion() });
    return;
  }

  // === Guided setup ===

  // 1. Explain what Ori is
  p.note(
    [
      "Ori creates a vault — your AI's persistent brain.",
      "Notes, connections, identity, all in markdown.",
      "",
      "Your agent reads and writes to this vault via MCP.",
      "Everything stays local. You own your memory.",
    ].join("\n"),
    "What is Ori?",
  );

  // 2. Vault location
  const vaultPath = await p.text({
    message: "Where should your vault live?",
    initialValue: path.join(os.homedir(), "brain"),
    validate: (value) => {
      if (!value) return "Please enter a path";
      return undefined;
    },
  });

  if (p.isCancel(vaultPath)) {
    p.cancel("Setup cancelled.");
    await writeState(targetDir, { onboarded: true, version: getVersion() });
    return;
  }

  const resolvedVault = path.resolve(vaultPath);

  // If they chose a different directory than current, scaffold there too
  if (path.resolve(targetDir) !== resolvedVault) {
    const s2 = p.spinner();
    s2.start(`Creating vault at ${resolvedVault}...`);
    await runInit({ targetDir: resolvedVault });
    s2.stop(`Vault created at ${resolvedVault}`);
  }

  // Explain project-vault relationship
  p.note(
    [
      `Your brain lives at: ${gold(resolvedVault)}`,
      "",
      `Use ${gold(`ori bridge claude-code --scope global --activation auto --vault ${resolvedVault}`)}`,
      `for Claude Code, or ${gold(`ori bridge generic --scope global --activation manual --vault ${resolvedVault}`)}`,
      "for any other MCP client. One brain, many projects.",
    ].join("\n"),
    "How it works",
  );

  // 3. MCP client config
  const client = await p.select({
    message: "Which AI client do you use?",
    options: [
      { value: "Claude Code", label: "Claude Code" },
      { value: "Cursor", label: "Cursor" },
      { value: "Other", label: "Other MCP client" },
    ],
  });

  if (!p.isCancel(client)) {
    const config = MCP_CONFIGS[client as string];
    if (config) {
      p.note(
        [
          `Add this to ${dim(config.file)}:`,
          "",
          gold(config.snippet),
        ].join("\n"),
        "MCP Configuration",
      );
    }
  }

  // 4. Vault structure explainer
  p.note(
    [
      `${gold("self/")}       Your agent's identity, goals, methodology`,
      `${gold("notes/")}      Your knowledge graph (flat, wiki-linked)`,
      `${gold("inbox/")}      Raw captures waiting to be processed`,
      `${gold("ops/")}        Daily ops, reminders, session logs`,
      `${gold("templates/")}  Note schemas`,
    ].join("\n"),
    "Vault structure",
  );

  // 5. Done
  p.outro(`Your memory starts now. Run ${gold(`ori bridge claude-code --scope global --activation auto --vault ${resolvedVault}`)} or ${gold(`ori bridge generic --scope global --activation manual --vault ${resolvedVault}`)}.`);

  // Write state
  await writeState(resolvedVault, { onboarded: true, version: getVersion() });
  if (path.resolve(targetDir) !== resolvedVault) {
    await writeState(targetDir, { onboarded: true, version: getVersion() });
  }

}

function getVersion(): string {
  // Best effort — read from package.json at runtime would require fs
  // Just hardcode the current version; state.version is informational
  return "0.4.0";
}
