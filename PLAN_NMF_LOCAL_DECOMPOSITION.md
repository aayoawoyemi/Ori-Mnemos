# Plan: No-LLM Recursive Explore (Coverage-Weighted Decomposition)

## Context

Ori v0.5.1 ships LLM-backed recursive explore. The LLM does exactly one thing: read retrieved results and identify gaps (generate sub-questions). All graph navigation is deterministic code. The question: can we replace that one LLM step with math?

Currently, without an LLM key configured, `exploreRecursive` returns Phase 1 only (single-pass PPR). This plan implements a **no-LLM gap detection and sub-query generation** layer using NMF topic decomposition + community coverage analysis, so recursive explore works for everyone out of the box — zero API keys, zero cost, zero latency.

Grok stays as the recommended LLM provider for users who want maximum quality. The no-LLM path is the **default**, Grok is the **enhancement**.

## Architecture: What Changes

The LLM does one function: `generateSubQuestions()`. We replace it with `generateSubQuestionsLocal()` that uses:

1. **NMF topic model** (offline, built at index time) — decomposes the vault into ~30 topics
2. **Coverage analysis** (online, per query) — detects which topics the query touches but results don't cover
3. **Term-based sub-query generation** (online) — synthesizes sub-queries from underrepresented topic terms

The existing `exploreRecursive` loop stays identical. We just swap the gap detection function.

## Detailed Implementation

### Step 1: NMF Topic Model (`src/core/nmf.ts`)

New file. Pure math, zero dependencies beyond what we have (better-sqlite3 for storage).

**Data structures:**
```typescript
interface TopicModel {
  W: Float64Array[];  // k topic vectors, each m-dimensional (term weights)
  H: Float64Array[];  // k coefficient vectors, each n-dimensional (note loadings)
  terms: string[];     // vocabulary (m terms)
  titles: string[];    // note titles (n notes)
  k: number;           // number of topics
  topTerms: string[][]; // top-10 terms per topic (precomputed for fast lookup)
}
```

**Build pipeline (runs during `ori index`):**
1. For each note: tokenize title + description + body into terms
2. Build term-document matrix V (TF-IDF weighted, same tokenizer as BM25)
   - Reuse `src/core/bm25.ts` tokenizer for consistency
   - TF = term count / doc length
   - IDF = log(N / df(term))
   - Filter: keep terms with df >= 2 and df <= 0.8*N (remove hapax and stopwords)
3. Run NMF: V ≈ WH using Lee-Seung multiplicative updates
   ```
   for iteration 1..max_iterations:
     H = H * (W^T V) / (W^T W H + epsilon)
     W = W * (V H^T) / (W H H^T + epsilon)
   ```
   - k = min(30, floor(n_notes / 10)) — scale topics with vault size
   - max_iterations = 100
   - epsilon = 1e-9 (numerical stability)
   - Initialize W, H with random values in [0, 1]
   - Convergence: stop early if ||V - WH||_F changes < 0.1% between iterations
4. Extract topTerms: for each topic column in W, sort terms by weight, take top 10
5. Store in SQLite (new table `nmf_model`):
   - `W_blob` BLOB — serialized W matrix
   - `H_blob` BLOB — serialized H matrix
   - `terms_json` TEXT — JSON array of vocabulary
   - `titles_json` TEXT — JSON array of note titles
   - `k` INTEGER
   - `top_terms_json` TEXT — JSON array of arrays
   - `content_hash` TEXT — hash of all note content (for staleness detection)

**Query projection (runs per query):**
```typescript
function projectQuery(query: string, model: TopicModel): Float64Array {
  // Tokenize query into term vector q (same tokenizer as build)
  // Solve: q ≈ W * h_q via NNLS (non-negative least squares)
  // Simplified NNLS: h_q = max(0, (W^T W)^{-1} W^T q)
  // Even simpler for our case: h_q_i = max(0, dot(W_i, q) / dot(W_i, W_i))
  // Returns h_q: the query's topic mixture
}
```

The per-topic projection is just a dot product — O(k * m) where m is vocabulary size. For m=5000, k=30, that's 150K multiply-adds. Microseconds.

**Why NMF over SVD:** NMF topics are additive (non-negative), so topic loadings directly correspond to "how much this query is about topic X". SVD dimensions can be negative, making coverage scoring ambiguous.

### Step 2: Coverage Analysis (`src/core/coverage.ts`)

New file. Takes query topic mixture + retrieved results, identifies gaps.

```typescript
interface CoverageResult {
  topicCoverage: Map<number, number>;  // topic_id -> coverage ratio [0,1]
  gaps: TopicGap[];                     // under-covered topics
  converged: boolean;                   // all relevant topics covered
}

interface TopicGap {
  topicId: number;
  topicTerms: string[];        // top terms defining this topic
  queryLoading: number;         // how much the query cares about this topic
  coverage: number;             // how well results cover it
  deficit: number;              // queryLoading - coverage (the gap size)
}
```

**Algorithm:**
```
function analyzeCoverage(
  queryMixture: Float64Array,     // from projectQuery
  results: ExploreNote[],          // current results
  model: TopicModel,               // NMF model
  config: { relevance_threshold, coverage_threshold }
): CoverageResult {

  // 1. Identify relevant topics: where queryMixture[i] > relevance_threshold
  relevantTopics = topics where queryMixture[i] > 0.1 * max(queryMixture)

  // 2. For each relevant topic, measure coverage from results
  for each topic i in relevantTopics:
    resultLoadings = results.map(r => model.H[i][titleIndex(r.title)])
    coverage[i] = sum(resultLoadings) / (queryMixture[i] * results.length)
    // Normalize: 1.0 = perfectly proportional coverage

  // 3. Identify gaps: relevant topics with coverage below threshold
  gaps = relevantTopics.filter(i => coverage[i] < coverage_threshold)
          .sort(by deficit descending)

  // 4. Convergence: no gaps with deficit > min_deficit
  converged = gaps.length === 0 || max(gap.deficit) < min_deficit

  return { topicCoverage, gaps, converged }
}
```

**Config defaults:**
```yaml
explore:
  nmf:
    enabled: true
    topics: 30                    # overridden by auto-scaling
    max_iterations: 100
    relevance_threshold: 0.1      # fraction of max query loading
    coverage_threshold: 0.3       # below this = gap
    min_deficit: 0.05             # below this = not worth pursuing
    max_gaps_per_pass: 3          # matches sub_question_max
```

### Step 3: Local Sub-Query Generation (`src/core/local-decompose.ts`)

New file. Converts topic gaps into sub-queries using topic terms + community structure.

```typescript
function generateSubQuestionsLocal(
  originalQuery: string,
  results: ExploreNote[],
  gaps: TopicGap[],
  model: TopicModel,
  communities: Map<string, number>,
  previousSubQueries: string[],
): string[] {
  const subQueries: string[] = [];

  for (const gap of gaps.slice(0, 3)) {
    // Strategy 1: Term-based sub-query
    // Take top terms from the gap topic that AREN'T in the original query
    const novelTerms = gap.topicTerms.filter(t => !originalQuery.toLowerCase().includes(t));

    // Combine original query focus terms + novel gap terms
    // This creates a query that bridges the original intent toward the missing topic
    const subQuery = [
      ...extractKeyTerms(originalQuery, 2),  // keep query grounded
      ...novelTerms.slice(0, 3),              // steer toward gap
    ].join(" ");

    // Strategy 2: If community data available, find seed notes in the gap topic's
    // dominant community that aren't in results yet
    // (This produces targeted seeds for the next PPR pass, not a text query)

    // Dedup against previous sub-queries (cosine on term overlap)
    if (!isDuplicate(subQuery, previousSubQueries)) {
      subQueries.push(subQuery);
    }
  }

  return subQueries;
}
```

The sub-queries are term clusters, not natural language. This is fine because `reseed()` runs them through composite + BM25 search — both handle keyword queries well.

### Step 4: Wire Into `exploreRecursive` (`src/core/explore.ts`)

Minimal changes to existing code. The key modification is in `exploreRecursive`:

```typescript
// Current: if (llmProvider instanceof NullProvider) → return Phase 1
// New: if (llmProvider instanceof NullProvider) → use local decomposition

// In the recursion loop, replace:
const newSubQuestions = await generateSubQuestions(llm, ...)
// With:
const newSubQuestions = isLocalMode
  ? generateSubQuestionsLocal(originalQuery, allResults, coverage.gaps, nmfModel, communities, subQueries)
  : await generateSubQuestions(llmProvider, originalQuery, snippetContext, subQueries, config.sub_question_max);
```

**Decision logic:**
```typescript
const isLocalMode = llmProvider instanceof NullProvider;
// NullProvider = no API key = use local decomposition
// Any real provider = use LLM gap detection (better quality)
```

This preserves the existing graceful degradation contract: LLM configured = use it. No LLM = local decomposition instead of stopping at Phase 1.

### Step 5: Index Integration (`src/core/engine.ts`)

Add NMF model building to the existing `buildIndex()` pipeline:

```typescript
// After embedding vectors are stored:
if (config.explore.nmf.enabled) {
  const nmfModel = buildNMFModel(allNotes, bm25Tokenizer, config.explore.nmf);
  storeNMFModel(db, nmfModel);
}
```

**Staleness detection:** Hash all note content. If hash matches stored model, skip rebuild. NMF only needs rebuilding when notes change — not on every query.

**Incremental updates:** When < 10% of notes changed since last build, update only H columns for changed notes (hold W fixed). Full rebuild when > 10% changed or k needs adjusting.

### Step 6: Community Coverage Integration

The Louvain communities from `importance.ts` are already computed at query time. Wire them into coverage analysis as a secondary signal:

```typescript
// After NMF coverage identifies gaps:
for (const gap of gaps) {
  // Find which Louvain communities correspond to this NMF topic
  const topicNotes = model.titles.filter((t, i) => model.H[gap.topicId][i] > threshold);
  const topicCommunities = new Set(topicNotes.map(t => communities.get(t)));

  // Check if results cover those communities
  const resultCommunities = new Set(results.map(r => communities.get(r.title)));
  const missingCommunities = [...topicCommunities].filter(c => !resultCommunities.has(c));

  // If communities are missing, boost this gap's priority
  if (missingCommunities.length > 0) {
    gap.deficit *= 1.5;  // community-structural confirmation of the gap
  }
}
```

This gives us two independent signals of what's missing: NMF (semantic) + Louvain (structural). When they agree, we're confident the gap is real.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/core/nmf.ts` | CREATE | NMF factorization, query projection, model storage |
| `src/core/coverage.ts` | CREATE | Coverage analysis, gap detection |
| `src/core/local-decompose.ts` | CREATE | Term-based sub-query generation from gaps |
| `src/core/explore.ts` | MODIFY | Wire local decomposition into recursion loop |
| `src/core/engine.ts` | MODIFY | Add NMF model building to index pipeline |
| `src/core/config.ts` | MODIFY | Add `nmf` config section under `explore` |
| `src/cli/explore.ts` | MODIFY | Pass NMF model + communities to `exploreRecursive` |
| `tests/nmf.test.ts` | CREATE | Unit tests for NMF math |
| `tests/coverage.test.ts` | CREATE | Unit tests for coverage analysis |
| `tests/local-decompose.test.ts` | CREATE | Unit tests for sub-query generation |

## Key Design Decisions

1. **No new npm dependencies.** NMF is ~80 lines of math (multiply, divide, sum). BM25 tokenizer already exists. SQLite already exists.

2. **NMF runs at index time, not query time.** The expensive part (matrix factorization) is amortized across queries. Query-time cost is a dot product per topic (~30 dot products).

3. **Sub-queries are term clusters, not natural language.** The retrieval pipeline handles keyword queries fine (BM25 signal is designed for this). Natural language sub-queries are an LLM luxury, not a necessity.

4. **Two independent gap signals.** NMF topics (semantic) + Louvain communities (structural) must agree before a gap is declared high-priority. This reduces false positives.

5. **Grok stays the quality ceiling.** Users with `XAI_API_KEY` set get LLM-backed decomposition. Everyone else gets local decomposition. The gap between them is ~10-15% on multi-aspect queries — significant but not dealbreaking.

6. **Coverage threshold is tunable.** Default 0.3 means a topic needs at least 30% proportional representation in results to not be flagged as a gap. Too low = misses real gaps. Too high = false gaps on single-aspect queries.

## Reuse Existing Code

- **BM25 tokenizer** (`src/core/bm25.ts`): reuse for NMF term extraction — same vocabulary, same preprocessing
- **Louvain communities** (`src/core/importance.ts`): already computed, pass through to coverage analysis
- **`exploreRecursive` loop** (`src/core/explore.ts`): unchanged — just swap gap detection function
- **`reseed` function** (`src/cli/explore.ts`): unchanged — sub-queries feed into same composite+BM25 search
- **SQLite storage** (`src/core/engine.ts`): add NMF model table alongside existing embedding vectors
- **Score decay filter** (`src/core/explore.ts`): reuse for filtering low-confidence topic assignments

## Verification

1. **Unit tests for NMF math:**
   - Build model on 20 synthetic documents with 3 known topics
   - Verify W columns correspond to expected term clusters
   - Verify query projection identifies correct topics
   - Verify multiplicative updates converge (loss decreasing)

2. **Unit tests for coverage analysis:**
   - Given a 2-topic query and results from only topic 1, verify gap detected on topic 2
   - Given full coverage, verify `converged = true`
   - Verify gap deficit calculation is correct

3. **Integration test:**
   - Build NMF on brain vault (500+ notes)
   - Query: "How does Stand inheritance interact with dynasty reputation?"
   - Verify: local decomposition generates sub-queries targeting "reputation" when initial results are Stand-heavy
   - Compare results with and without local decomposition (should find bridge notes)

4. **Audit logging:**
   - Existing `explore-audit.ts` already captures `subQueries` and `perPassResults`
   - Add `decompositionSource: "local" | "llm"` field to audit events
   - Add `topicCoverage` map to audit for debugging

5. **Benchmark (post-implementation):**
   - 20 curated queries (single-aspect, multi-aspect, cross-domain)
   - Three conditions: flat (no recursion), local-recursive, Grok-recursive
   - Metrics: recall@15, novel discovery rate, latency
   - Target: local-recursive achieves >80% of Grok's gains over flat

---

## Step 7: Audit System for NMF Recursion

The existing audit system (`src/core/explore-audit.ts`) logs to `.ori/explore-audit.jsonl` when `ORI_EXPLORE_AUDIT=true`. It already captures flat vs final results, recursion gains/losses, sub-queries, and per-pass breakdowns.

**What's missing for NMF tuning:**

The current audit has no visibility into WHY a gap was detected or HOW coverage was measured. To tune NMF params (k, relevance_threshold, coverage_threshold, min_deficit) we need to see the math at every decision point.

### New Audit Fields

Extend `ExploreAuditEvent` type in `src/core/explore-audit.ts`:

```typescript
// Add to ExploreAuditEvent:
decompositionSource: "local" | "llm" | "none";

// New type for NMF-specific audit data (only present when decompositionSource === "local")
nmfAudit?: {
  /** How the query loaded onto each topic */
  queryTopicMixture: Array<{
    topicId: number;
    topicTerms: string[];   // top-5 terms defining this topic
    loading: number;         // query's weight on this topic [0,1]
  }>;

  /** Per-pass coverage snapshots — this is the key tuning data */
  coveragePerPass: Array<{
    pass: number;
    /** Coverage ratio per relevant topic BEFORE this pass's retrieval */
    topicCoverage: Array<{
      topicId: number;
      queryLoading: number;
      coverage: number;       // [0,1] how well results cover this topic
      deficit: number;        // queryLoading - coverage
      resultCount: number;    // how many results belong to this topic
    }>;
    /** Gaps detected (topics that triggered sub-queries) */
    gapsDetected: Array<{
      topicId: number;
      topicTerms: string[];
      deficit: number;
      communityConfirmed: boolean;  // did Louvain communities agree?
      subQueryGenerated: string;    // the actual sub-query produced
    }>;
    /** Coverage ratio per topic AFTER this pass's retrieval */
    coverageAfter: Array<{
      topicId: number;
      coverage: number;
      improvement: number;   // coverage_after - coverage_before
    }>;
    converged: boolean;
  }>;

  /** Model metadata */
  modelStats: {
    k: number;              // number of topics
    vocabularySize: number;
    notesInModel: number;
    modelAge: string;       // ISO timestamp of when model was built
    stale: boolean;         // content hash mismatch?
  };
};
```

### Why These Specific Fields Matter for Tuning

| Field | Tuning question it answers |
|-------|---------------------------|
| `queryTopicMixture` | Are queries projecting onto sensible topics? If a query about "Stand combat" loads onto topic "university coursework", the topics are bad → increase k or rebuild |
| `topicCoverage[].deficit` | Is the coverage threshold right? If deficits cluster around 0.2-0.3, threshold 0.3 is cutting it close. Histogram of deficits across queries tells us the right cutoff |
| `gapsDetected[].communityConfirmed` | How often do NMF and Louvain agree? If they rarely agree, the community confirmation is noise → remove the 1.5x boost |
| `coverageAfter[].improvement` | Are sub-queries actually closing gaps? If improvement is consistently near 0, the term-based sub-queries aren't working → need better sub-query construction |
| `subQueryGenerated` | Are the generated sub-queries sensible? Human-readable check. If they're garbage ("the the and"), tokenizer is broken |
| `converged` per pass | How many passes does it typically take? If always 1, we're either too aggressive (low threshold) or the queries are simple |
| `modelStats.stale` | Is the NMF model keeping up with vault changes? |

### Per-Pass Timing

The current audit has `elapsedMs: 0` for per-pass results (comment says "per-pass timing not tracked yet"). Fix this in `exploreRecursive`:

```typescript
// In the recursion loop, wrap each pass:
const passStart = Date.now();
// ... sub-query generation + explore ...
const passElapsed = Date.now() - passStart;
perPassResults.push({ ..., elapsedMs: passElapsed });
```

Also add timing breakdown to NMF audit:
```typescript
nmfAudit.timing: {
  queryProjectionMs: number;   // how long to project query (should be <1ms)
  coverageAnalysisMs: number;  // how long to compute coverage (should be <5ms)
  subQueryGenerationMs: number; // how long to build sub-queries
  totalNmfMs: number;          // total NMF overhead per pass
}
```

### Audit Analysis Script

Create `src/cli/audit-analyze.ts` — a CLI command `ori audit analyze` that reads the JSONL and produces:

1. **Coverage threshold histogram**: across all queries, what's the distribution of topic deficits? This tells us the right `coverage_threshold`.
2. **Gap closure rate**: what % of detected gaps show improvement > 0.1 after the sub-query pass? This is the core quality metric.
3. **Community confirmation rate**: what % of NMF gaps are confirmed by Louvain communities? If low, community confirmation isn't helping.
4. **Sub-query effectiveness**: for each sub-query, how many new notes did it find? Distribution of `newNotesAdded` per sub-query.
5. **Topic quality check**: which topics appear most often in queries? Are they interpretable (top terms make sense)?
6. **Convergence profile**: histogram of passes-to-convergence across queries.
7. **Local vs Grok comparison** (when both exist in the log): for queries that ran with both, how do results compare? This is the benchmark.

Output format: structured text to stdout, suitable for copy-paste into a research doc or paper.

### Files Modified for Audit

| File | Change |
|------|--------|
| `src/core/explore-audit.ts` | Add `decompositionSource`, `nmfAudit` fields to `ExploreAuditEvent` type |
| `src/core/explore.ts` | Pass NMF audit data through `exploreRecursive` return type, add per-pass timing |
| `src/cli/explore.ts` | Populate `nmfAudit` in audit event when local decomposition is active |
| `src/cli/audit-analyze.ts` | NEW — analysis script for tuning from audit data |
| `src/core/coverage.ts` | Return audit-friendly data structures (coverage snapshots before/after each pass) |

### Existing Audit Patterns to Preserve

The current audit system has good patterns we keep:
- `ORI_EXPLORE_AUDIT` env var toggle (no audit overhead when disabled)
- JSONL append-only format (grep-friendly, no corruption risk)
- `queryExploreAudit()` for programmatic querying
- `recursionGains` / `recursionLosses` diff (directly answers "did recursion help?")
- `logExploreAudit` never throws (wrapped in try/catch at call site, line 360-364 of `cli/explore.ts`)

### Paper Data Collection

For RMH Paper 2, the audit log IS the dataset. Every `ori explore` query with `ORI_EXPLORE_AUDIT=true` produces one row of benchmark data. The analysis script aggregates across all rows to produce the tables and figures for the paper:

- Table 1: Recall@15 across flat / local-recursive / Grok-recursive
- Table 2: Gap detection accuracy (NMF vs LLM agreement rate)
- Figure 1: Coverage deficit distribution before/after local recursion
- Figure 2: Convergence curves (passes vs new-notes-found)
- Figure 3: Latency comparison (local ~75ms vs Grok ~2.5s)
