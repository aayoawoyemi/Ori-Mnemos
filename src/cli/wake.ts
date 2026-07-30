/**
 * ori wake — bounded session boot runner (manifest -> engine).
 */
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import { loadWakeSources, assembleWakeInputs } from "../core/wake-sources.js";
import { buildWakePayload } from "../core/wake.js";
import { parseTemporal, classifyReminder } from "../core/temporal.js";

export async function runWake(startDir: string, budgetLines: number): Promise<{
  success: boolean;
  lines: string[];
  sections: Record<string, number>;
}> {
  const vaultRoot = await findVaultRoot(startDir);
  const config = await loadConfig(getVaultPaths(vaultRoot).config);
  const sources = loadWakeSources(config as never);
  const inputs = await assembleWakeInputs(vaultRoot, sources);

  const today = new Date().toISOString().slice(0, 10);

  // Mechanical temporal filter (design v2): only due/upcoming reminders survive.
  // Words like "today" are never trusted — only ISO dates. Undated lines stay
  // (classifyReminder returns "note") so plain reminders are not lost.
  const reminderLines = inputs.reminders
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .filter((l) => {
      const t = parseTemporal(l, null);
      const cls = classifyReminder(t, today);
      if (cls === "due" || cls === "upcoming") return true;
      if (cls !== "note") return false; // expired never surfaces
      // Undated notes: keep only if captured recently (30d) or capture date unknown.
      if (t.capturedAt === null) return true;
      const ageDays = (Date.parse(today) - Date.parse(t.capturedAt)) / 86400000;
      return ageDays <= 30;
    });
  const wakeInputs = {
    ...inputs,
    reminders: reminderLines.join("\n"),
    daily: inputs.activity.map((l) => ({ date: today, lines: [l] }))
  };

  const out = buildWakePayload(wakeInputs, budgetLines);
  return { success: true, lines: out.lines, sections: out.sections };
}
