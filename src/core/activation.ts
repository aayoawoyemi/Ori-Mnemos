/**
 * Spreading activation engine.
 *
 * When notes are retrieved, vitality boosts propagate to neighbors along
 * wiki-link edges. Boosts are stored in SQLite, not frontmatter.
 */

import type Database from "better-sqlite3";
import type { LinkGraph } from "./graph.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ActivationConfig {
  enabled: boolean;     // default true
  damping: number;      // default 0.6
  max_hops: number;     // default 2
  min_boost: number;    // default 0.01
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  enabled: true,
  damping: 0.6,
  max_hops: 2,
  min_boost: 0.01,
};

// ---------------------------------------------------------------------------
// Spread computation
// ---------------------------------------------------------------------------

export interface ActivationResult {
  source: string;
  utility: number;
  propagated: Map<string, number>;  // title → boost amount
}

/**
 * BFS from source. At hop k: boost = utility × damping^k.
 * Undirected: follows both linkGraph.outgoing and linkGraph.incoming.
 * Visited set = shortest-path guarantee, no double-counting.
 * Source note does NOT self-boost.
 */
export function computeActivationSpread(
  source: string,
  utility: number,
  linkGraph: LinkGraph,
  config: ActivationConfig = DEFAULT_ACTIVATION_CONFIG,
): ActivationResult {
  const propagated = new Map<string, number>();

  if (!config.enabled || utility <= 0 || config.max_hops <= 0) {
    return { source, utility, propagated };
  }

  const visited = new Set<string>();
  visited.add(source); // source does NOT self-boost

  // BFS: queue of [title, hop_distance]
  let frontier: Array<[string, number]> = [[source, 0]];

  while (frontier.length > 0) {
    const nextFrontier: Array<[string, number]> = [];

    for (const [node, hop] of frontier) {
      if (hop >= config.max_hops) continue;

      // Get undirected neighbors
      const outgoing = linkGraph.outgoing.get(node);
      const incoming = linkGraph.incoming.get(node);
      const neighbors = new Set<string>();
      if (outgoing) for (const n of outgoing) neighbors.add(n);
      if (incoming) for (const n of incoming) neighbors.add(n);

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);

        const nextHop = hop + 1;
        const boost = utility * Math.pow(config.damping, nextHop);

        if (boost >= config.min_boost) {
          propagated.set(neighbor, boost);
          nextFrontier.push([neighbor, nextHop]);
        }
      }
    }

    frontier = nextFrontier;
  }

  return { source, utility, propagated };
}

// ---------------------------------------------------------------------------
// SQLite persistence
// ---------------------------------------------------------------------------

/** Decay constant: half-life ~7 days (exp(-0.1 * 7) ≈ 0.497) */
const DECAY_RATE = 0.1;

/**
 * Load all boosts from DB. Apply time-based decay at read time.
 * Returns decayed current effective boosts.
 */
export function loadBoosts(db: InstanceType<typeof Database>): Map<string, number> {
  const rows = db
    .prepare("SELECT title, boost, updated FROM boosts")
    .all() as Array<{ title: string; boost: number; updated: string }>;

  const now = new Date();
  const result = new Map<string, number>();

  for (const row of rows) {
    const updatedDate = new Date(row.updated);
    const daysSinceUpdate = Math.max(0, (now.getTime() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));
    const decayedBoost = row.boost * Math.exp(-DECAY_RATE * daysSinceUpdate);

    if (decayedBoost >= 0.001) { // skip effectively-zero boosts
      result.set(row.title, decayedBoost);
    }
  }

  return result;
}

/**
 * Write boosts to DB in one transaction.
 * DECAY-BEFORE-ACCUMULATE: read existing, decay to now, add new, clamp to 1.0, store.
 */
export function applyActivationBoosts(
  db: InstanceType<typeof Database>,
  boosts: Map<string, number>,
): void {
  if (boosts.size === 0) return;

  const now = new Date();
  const nowISO = now.toISOString();

  const selectStmt = db.prepare("SELECT boost, updated FROM boosts WHERE title = ?");
  const upsertStmt = db.prepare(
    "INSERT OR REPLACE INTO boosts (title, boost, updated) VALUES (?, ?, ?)"
  );

  const transaction = db.transaction(() => {
    for (const [title, newBoost] of boosts) {
      let finalBoost = newBoost;

      // Decay existing stored value to now before adding
      const existing = selectStmt.get(title) as { boost: number; updated: string } | undefined;
      if (existing) {
        const updatedDate = new Date(existing.updated);
        const daysSinceUpdate = Math.max(0, (now.getTime() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));
        const decayedExisting = existing.boost * Math.exp(-DECAY_RATE * daysSinceUpdate);
        finalBoost = decayedExisting + newBoost;
      }

      // Clamp to 1.0
      finalBoost = Math.min(finalBoost, 1.0);

      upsertStmt.run(title, finalBoost, nowISO);
    }
  });

  transaction();
}
