import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const BRIDGE_SENTINEL = "<!-- ori-bridge:claude-code -->";
const ORI_HOOK_CMD_MARKER = "hooks/ori/";

const CLAUDE_SNIPPET = `# Ori Mnemos - Claude Code Bridge

## Session Rhythm
Every session: Orient -> Work -> Persist

### Orient (always first)
- Ori injects identity via MCP instructions automatically
- Call \`ori_orient\` for session briefing (daily + goals + reminders + vault status)
- Use \`ori_orient brief=false\` for full context including identity and methodology
- Read \`ori://identity\` or \`ori://goals\` resources for specific context

### Work
- Use \`ori_query_ranked\` to find related notes before creating new ones
- Use \`ori add\` to capture insights to inbox/
- NEVER write to notes/ directly — use \`ori add\` then \`ori_promote\`

### Persist
- Use \`ori_update\` file=daily to mark completed items
- Use \`ori_update\` file=goals to update active threads
- Run \`ori validate\` on notes you create
- Keep notes atomic and link to maps
`;

function localSettings(hooksDir: string) {
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: "node .claude/hooks/orient.mjs",
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Write",
          hooks: [
            {
              type: "command",
              command: "node .claude/hooks/validate.mjs",
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node .claude/hooks/capture.mjs",
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

function globalSettings(hooksDir: string) {
  const orientCmd = `node "${path.join(hooksDir, "orient.mjs")}"`;
  const validateCmd = `node "${path.join(hooksDir, "validate.mjs")}"`;
  const captureCmd = `node "${path.join(hooksDir, "capture.mjs")}"`;
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: orientCmd, timeout: 10 }],
        },
      ],
      PostToolUse: [
        {
          matcher: "Write",
          hooks: [{ type: "command", command: validateCmd, timeout: 5 }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: captureCmd, timeout: 10 }],
        },
      ],
    },
  };
}

function hookEntryHasOriMarker(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h: unknown) => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as Record<string, unknown>).command;
    return (
      typeof cmd === "string" &&
      cmd.replace(/\\/g, "/").includes(ORI_HOOK_CMD_MARKER)
    );
  });
}

type SettingsShape = {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
};

async function mergeIntoSettingsFile(
  settingsPath: string,
  incoming: ReturnType<typeof globalSettings>
): Promise<void> {
  let existing: SettingsShape = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    existing = JSON.parse(raw) as SettingsShape;
  } catch {
    // file missing or unparseable - start fresh
  }

  const merged: SettingsShape = {
    ...existing,
    hooks: { ...(existing.hooks ?? {}) },
  };

  for (const [event, entries] of Object.entries(incoming.hooks)) {
    const current = (merged.hooks![event] ?? []) as unknown[];
    const alreadyInstalled = current.some(hookEntryHasOriMarker);
    if (!alreadyInstalled) {
      merged.hooks![event] = [...current, ...entries];
    }
  }

  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2));
}

function getAdaptersDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "adapters", "claude-code");
}

async function copyHooks(adaptersDir: string, hooksDir: string): Promise<void> {
  await fs.mkdir(hooksDir, { recursive: true });
  for (const hook of ["orient.mjs", "validate.mjs", "capture.mjs"]) {
    await fs.copyFile(
      path.join(adaptersDir, "hooks", hook),
      path.join(hooksDir, hook)
    );
  }
}

export async function runBridgeClaudeCode(startDir: string) {
  const root = path.resolve(startDir);
  const claudeDir = path.join(root, ".claude");
  const hooksDir = path.join(claudeDir, "hooks");
  const adaptersDir = getAdaptersDir();

  await copyHooks(adaptersDir, hooksDir);

  const claudePath = path.join(root, "CLAUDE.md");
  let existing = "";
  try {
    existing = await fs.readFile(claudePath, "utf8");
  } catch {
    // file doesn't exist yet
  }
  if (!existing.includes(BRIDGE_SENTINEL)) {
    await fs.appendFile(claudePath, `\n\n${BRIDGE_SENTINEL}\n${CLAUDE_SNIPPET}`);
  }

  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(localSettings(hooksDir), null, 2)
  );

  return {
    success: true,
    data: { claudePath, hooksDir, scope: "project" },
    warnings: [],
  };
}

export async function runBridgeClaudeCodeGlobal() {
  const homeDir = os.homedir();
  const globalClaudeDir = path.join(homeDir, ".claude");
  const globalHooksDir = path.join(globalClaudeDir, "hooks", "ori");
  const globalSettingsPath = path.join(globalClaudeDir, "settings.json");
  const adaptersDir = getAdaptersDir();

  await copyHooks(adaptersDir, globalHooksDir);
  await mergeIntoSettingsFile(globalSettingsPath, globalSettings(globalHooksDir));

  return {
    success: true,
    data: { hooksDir: globalHooksDir, settingsPath: globalSettingsPath, scope: "global" },
    warnings: [],
  };
}
