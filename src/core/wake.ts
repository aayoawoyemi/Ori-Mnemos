/**
 * ori wake — bounded session boot (docs/wake-nap-design.md).
 * Pure functions: no I/O, no LLM. Budget is a hard law.
 */
export type WakeInputs = {
  identity: string;
  goals: string;
  reminders: string;
  daily: string | DailyEntry[];
  warmNotes: Array<{ title: string; decayed: number }>;
  vaultStats: {
    noteCount: number;
    inboxCount: number;
    zones?: Record<string, number>;
  };
  notices?: string[];
};

export type DailyEntry = { date: string; lines: string[] };

export function coverDaily(
  daily: string | DailyEntry[],
  alpha: number
): Array<{ date: string; lines: string[] }> {
  const parseDailyString = (content: string): DailyEntry[] => {
    const entries: DailyEntry[] = [];
    const headerRegex = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/gm;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = headerRegex.exec(content)) !== null) {
      const date = match[1];
      const start = match.index + match[0].length;
      if (entries.length > 0) {
        entries[entries.length - 1].lines = content
          .slice(lastIndex, match.index)
          .split(/\r?\n/)
          .filter((l) => l.trim() !== '');
      }
      entries.push({ date, lines: [] });
      lastIndex = start;
    }
    if (entries.length > 0) {
      entries[entries.length - 1].lines = content
        .slice(lastIndex)
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '');
    }
    return entries;
  };

  const today = new Date().toISOString().slice(0, 10);
  const toDate = (s: string) => new Date(s + 'T00:00:00Z');
  const toDays = (d: number) => Math.max(d, 1);

  let entries: DailyEntry[] =
    typeof daily === 'string' ? parseDailyString(daily) : daily;

  entries.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

  const out: Array<{ date: string; lines: string[] }> = [];
  let count = 0;
  let run: { start: string; end: string; n: number } | null = null;
  const flushRun = () => {
    if (run) {
      out.push({ date: run.end, lines: [`${run.end}..${run.start}: ${run.n} entries`] });
      run = null;
    }
  };
  for (const entry of entries) {
    count++;
    const age =
      (toDate(today).getTime() - toDate(entry.date).getTime()) / (1000 * 60 * 60 * 24);
    if (count <= alpha * toDays(age) && age < 2) {
      // fovea: recent entries stay raw
      flushRun();
      out.push(entry);
    } else if (age <= 30) {
      // mid-range: one line per entry
      flushRun();
      out.push({ date: entry.date, lines: [`${entry.date}: ${entry.lines[0] ?? ""}`] });
    } else {
      // old: group consecutive runs into one line
      if (run) {
        run.end = entry.date;
        run.n++;
      } else {
        run = { start: entry.date, end: entry.date, n: 1 };
      }
    }
  }
  flushRun();
  return out;
}

export function buildWakePayload(
  inputs: WakeInputs,
  budgetLines: number
): { lines: string[]; sections: Record<string, number> } {
  const caps = {
    identity_line: 1,
    active_goals: 8,
    reminders_due: 6,
    daily_recent: 20,
    warm_notes: 10,
    resurfaced: 0,
    vault_vitals: 4,
    notices: 2,
  };

  const sections: {
    name: keyof typeof caps;
    lines: string[];
    cap: number;
  }[] = [];

  // Identity line
  let identityLine = "";
  const identityLines = inputs.identity.split("\n");
  for (const line of identityLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/Name:/i.test(trimmed)) {
      identityLine = trimmed;
      break;
    }
  }
  if (!identityLine) {
    const first = identityLines.find(
      (l) => l.trim() && !l.trim().startsWith("#")
    );
    identityLine = first?.trim() ?? "";
  }
  sections.push({
    name: "identity_line",
    lines: identityLine ? [identityLine] : [],
    cap: caps.identity_line,
  });

  // Active goals
  const activeGoals = inputs.goals
    .split("\n")
    .filter((g) => g.trim().startsWith("-") || g.trim().startsWith("*"))
    .map((g) => g.trim());
  sections.push({
    name: "active_goals",
    lines: activeGoals.slice(0, caps.active_goals),
    cap: caps.active_goals,
  });

  // Reminders due
  const today = new Date().toISOString().slice(0, 10);
  const dueKeywords = ["today", "overdue", "due", today];
  const remindersDue = inputs.reminders
    .split("\n")
    .filter((r) => {
      const lower = r.toLowerCase();
      return dueKeywords.some((k) => lower.includes(k));
    })
    .map((r) => r.trim());
  sections.push({
    name: "reminders_due",
    lines: remindersDue.slice(0, caps.reminders_due),
    cap: caps.reminders_due,
  });

  // Daily recent
  const recentLines = coverDaily(inputs.daily, 2)
    .flatMap((e) => e.lines)
    .slice(0, caps.daily_recent);
  sections.push({
    name: "daily_recent",
    lines: recentLines,
    cap: caps.daily_recent,
  });

  // Warm notes
  const warmLines = inputs.warmNotes
    .map(
      (n) => `${n.title} (${n.decayed.toFixed(2)})`.trim()
    )
    .slice(0, caps.warm_notes);
  sections.push({
    name: "warm_notes",
    lines: warmLines,
    cap: caps.warm_notes,
  });

  // Resurfaced (none for now)
  sections.push({ name: "resurfaced", lines: [], cap: caps.resurfaced });

  // Vault vitals
  const vaultLines: string[] = [];
  const { noteCount, inboxCount, zones } = inputs.vaultStats;
  vaultLines.push(`Notes: ${noteCount}`, `Inbox: ${inboxCount}`);
  if (zones) {
    vaultLines.push(`Zones: ${Object.entries(zones).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  sections.push({
    name: "vault_vitals",
    lines: vaultLines.slice(0, caps.vault_vitals),
    cap: caps.vault_vitals,
  });

  // Notices
  const noticeLines = (inputs.notices ?? []).map((n) => n.trim());
  sections.push({
    name: "notices",
    lines: noticeLines.slice(0, caps.notices),
    cap: caps.notices,
  });

  // Helper totals
  const sectionInfo = sections.map((s) => ({
    ...s,
    count: s.lines.length,
  }));

  // Drop sections if over budget
  const dropOrder: Array<keyof typeof caps> = [
    "notices",
    "vault_vitals",
    "warm_notes",
    "daily_recent",
    "reminders_due",
    "active_goals",
  ];
  let total = sectionInfo.reduce((sum, s) => sum + s.count, 0);

  for (const name of dropOrder) {
    if (total <= budgetLines) break;
    const sec = sectionInfo.find((s) => s.name === name);
    if (!sec || sec.count === 0) continue;
    total -= sec.count;
    sec.lines = [];
    sec.count = 0;
  }

  // Trim last included section if still over
  if (total > budgetLines) {
    // Find last section with lines
    for (let i = sectionInfo.length - 1; i >= 0; i--) {
      const sec = sectionInfo[i];
      if (sec.count > 0) {
        const excess = total - budgetLines;
        if (excess >= sec.count) {
          sec.lines = [];
          sec.count = 0;
        } else {
          sec.lines = sec.lines.slice(0, sec.count - excess);
          sec.count = sec.lines.length;
        }
        break;
      }
    }
  }

  // Build output
  const outputLines: string[] = [];
  const sectionMap: Record<string, number> = {};

  for (const sec of sectionInfo) {
    sectionMap[sec.name] = sec.count;
    outputLines.push(...sec.lines);
  }

  return { lines: outputLines, sections: sectionMap };
}
