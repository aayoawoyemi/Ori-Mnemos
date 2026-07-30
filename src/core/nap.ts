/**
 * ori nap — agent-loop consolidation queue (docs/wake-nap-design.md).
 * Math proposes, agent disposes. One item per call.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export type NapScan = {
    inboxNotes: Array<{ title: string; ageDays: number }>;
    mergeCandidates: Array<{
        a: string;
        b: string;
        similarity: number;
        community: number;
    }>;
    fadingNotes: Array<{
        title: string;
        vitality: number;
        isArticulationPoint: boolean;
    }>;
    danglingLinks: Array<{
        from: string;
        target: string;
        suggestions: string[];
    }>;
    staleMaps: Array<{ community: number; drift: number }>;
    stateDir: string;
};

export type NapItem =
    | { kind: "inbox_promote"; title: string }
    | { kind: "merge_candidates"; a: string; b: string; similarity: number }
    | { kind: "fade_review"; notes: string[] }
    | { kind: "dangling_repair"; from: string; target: string; suggestions: string[] }
    | { kind: "summary_refresh"; community: number; drift: number };

export async function generateNapQueue(
    scan: NapScan
): Promise<{ items: NapItem[] }> {
    const ledger = await loadKeptSeparate(scan.stateDir);

    // inbox_promote
    const inboxItems: NapItem[] = scan.inboxNotes
        .filter((n) => n.ageDays >= 7)
        .sort((a, b) => b.ageDays - a.ageDays)
        .map((n) => ({ kind: "inbox_promote" as const, title: n.title }));

    // merge_candidates
    const mergeKeys = Array.from(ledger);
    const mergeItems: NapItem[] = scan.mergeCandidates
        .filter((c) => c.similarity >= 0.86)
        .sort((a, b) => {
            if (a.a < b.a) return -1;
            if (a.a > b.a) return 1;
            if (a.b < b.b) return -1;
            if (a.b > b.b) return 1;
            return 0;
        })
        .filter((c) => {
            const key = createKey(c.a, c.b);
            return !mergeKeys.includes(key);
        })
        .map((c) => ({
            kind: "merge_candidates" as const,
            a: c.a,
            b: c.b,
            similarity: c.similarity,
        }));

    // fade_review
    const fadeNotes = scan.fadingNotes.filter((n) => !n.isArticulationPoint);
    const fadeGroups: NapItem[] = [];
    for (let i = 0; i < fadeNotes.length; i += 5) {
        const slice = fadeNotes.slice(i, i + 5).map((n) => n.title);
        fadeGroups.push({ kind: "fade_review" as const, notes: slice });
    }

    // dangling_repair
    const danglingItems: NapItem[] = scan.danglingLinks.map((l) => ({
        kind: "dangling_repair" as const,
        from: l.from,
        target: l.target,
        suggestions: l.suggestions,
    }));

    // summary_refresh
    const summaryItems: NapItem[] = scan.staleMaps.map((s) => ({
        kind: "summary_refresh" as const,
        community: s.community,
        drift: s.drift,
    }));

    const items: NapItem[] = [
        ...inboxItems,
        ...mergeItems,
        ...fadeGroups,
        ...danglingItems,
        ...summaryItems,
    ];

    return { items };
}

export function takeNapItem(
    queue: { items: NapItem[] }
): NapItem | null {
    return queue.items[0] ?? null;
}

export async function recordKeptSeparate(
    stateDir: string,
    a: string,
    b: string
): Promise<void> {
    await fs.mkdir(stateDir, { recursive: true });
    const filePath = join(stateDir, "kept-separate.json");
    let data: string[] = [];
    try {
        const file = await fs.readFile(filePath, { encoding: "utf8" });
        data = JSON.parse(file);
        if (!Array.isArray(data)) data = [];
    } catch {
        // file doesn't exist or invalid, start new
        data = [];
    }
    const key = createKey(a, b);
    if (!data.includes(key)) {
        data.push(key);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    }
}

async function loadKeptSeparate(stateDir: string): Promise<Set<string>> {
    const filePath = join(stateDir, "kept-separate.json");
    let data: string[] = [];
    try {
        const file = await fs.readFile(filePath, { encoding: "utf8" });
        data = JSON.parse(file);
        if (!Array.isArray(data)) data = [];
    } catch {
        return new Set();
    }
    return new Set(data);
}

function createKey(x: string, y: string): string {
    const [a, b] = [x, y].sort();
    return `${a}|${b}`;
}
