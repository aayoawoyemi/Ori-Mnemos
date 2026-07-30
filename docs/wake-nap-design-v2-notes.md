# Wake/nap design v2 — corrections from Aayo's review + lab findings (2026-08-01)

## 1. Budget law vs Ori's thesis — RESOLVED (Aayo's question answered honestly)
Wake is a BOOT briefing, not retrieval. Effectiveness loss is bounded because wake was never the recall path:
the graph + 4-signal retrieval remains the way anything old is found. What wake loses vs raw-dump orient:
long-tail identity prose and full methodology — recoverable ON DEMAND via retrieval. What it gains: flat cost
forever + the agent actually reads it (a 400-line orient gets skimmed by models too). Thesis-compatible:
compression for PRESENCE, retrieval for DEPTH, learning decides what earns presence. (Same split as
fovea/periphery in the navigable-memory note.)

## 2. Vault is user-shaped — DESIGN CHANGE (from Aayo: 'vault is editable, users add their own stuff')
Kill the hardcoded daily.md/reminders.md assumption (my own vault proved it wrong: 12-line daily, activity
in today.md/sessions/). Wake v2 reads a MANIFEST, not fixed paths:
  wake.sources in ori.config.yaml: ordered list of { path|glob, role: identity|goals|due|activity|custom,
  cap, mode: head|tail|fovea|due-scan }. Defaults ship matching the scaffold; users remap freely.
Open-source-shaped: the budget ladder is the invariant, the sources are configuration.

## 3. Temporal mechanics — DESIGN CHANGE (Aayo's wedding example)
Every surfaced line gets MECHANICAL dates, not keyword matching. Reminder grammar:
  captured_at (mechanical, from entry/frontmatter/file mtime) + event_date (parsed if present).
Semantics: event_date in future -> upcoming (surface when within lead window, e.g. wedding: monthly til
T-14d, then daily); event_date passed -> expired (nap offers retirement, never shows as 'due today');
no event_date -> note, not reminder. The 'NBA meeting today' failure becomes impossible: 'today' the WORD
is never trusted, only dates. Agent answering 'what's coming up' reads computed state, not vibes.
This is resurfacing math v0 — the Companion inherits it wholesale.

## 4. Demarcation — DECIDED (Aayo: lightest possible, humans rarely read it, compression eventually)
One-line micro-headers `## goals` style only where section type changes: costs ~5 lines, keeps agent
parseability (models chunk labeled blocks reliably). No decoration beyond that.

## 5. Traces — AUDIT RESULT (checked as asked)
HAVE: ops/access.jsonl 2,206 retrieval events (query, intent, ranked results, scores, wasExploration flags —
real longitudinal data); note_q 1,134 rows; boosts 1,392 rows; co_occurrence + q_history + memory_events tables live.
EMPTY: stage_log 0 rows (stage learning has never logged locally — CLI path lacks intelligenceDb; only serve-mode
sessions with externalDb write it, and this brain has run CLI-only).
MISSING for wake/nap validation: no orient-size history, no session-boot outcomes, no resurfacing events.
Action: wake/nap must LOG from day one (wake_events + nap_events into memory_events table) so effectiveness
claims become measurable — supports the benchmark story for v0.7.

## Next lab steps before wiring
- Re-cut fovea input contract to manifest roles (activity glob over sessions/*.md + today.md tail).
- Implement date-grammar parser (captured_at/event_date) + property tests for wedding-case semantics.
- Prototype wake-size telemetry on MY sessions for a week = first real effectiveness data.
