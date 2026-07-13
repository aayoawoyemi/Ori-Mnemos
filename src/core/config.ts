import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { DEFAULT_LLM_CONFIG, type LlmConfig } from "./llm.js";

export type TemplateMapping = {
  default: string;
  by_type: Record<string, string>;
};

export type VitalityConfig = {
  decay: Record<string, number>;
  base: number;
  model?: string;
  actr_decay?: number;
  metabolic_rates?: {
    self: number;
    notes: number;
    ops: number;
  };
  structural_boost_per_link?: number;
  structural_boost_cap?: number;
  revival_decay_rate?: number;
  revival_window_days?: number;
  access_saturation_k?: number;
  zone_thresholds?: {
    active_floor?: number;   // default 0.6
    stale_floor?: number;    // default 0.3
    fading_floor?: number;   // default 0.1
  };
};

export type PromoteConfig = {
  auto: boolean;
  require_llm: boolean;
  project_keywords: Record<string, string[]>;
  project_map_routing: Record<string, string>;
  default_area: string;
};

export type GraphConfig = {
  pagerank_alpha: number;
  bridge_vitality_floor: number;
  hub_degree_multiplier: number;
};

export type EngineConfig = {
  embedding_model: string;
  embedding_dims: number;
  piecewise_bins: number;
  community_dims: number;
  db_path: string;
};

export type RetrievalConfig = {
  default_limit: number;
  candidate_multiplier: number;
  rrf_k: number;
  signal_weights: {
    composite: number;
    keyword: number;
    graph: number;
    warmth: number;
  };
  exploration_budget: number;
};

export type BM25Config = {
  k1: number;
  b: number;
  title_boost: number;
  description_boost: number;
};

export type RerankConfig = {
  /** Off by default: the cross-encoder model (~90MB) downloads on first use. */
  enabled: boolean;
  /** HF text-classification cross-encoder id. */
  model: string;
  /** Rerank the top_k candidates; the rest keep their order below. */
  top_k: number;
  /** 0..1 — weight of cross-encoder score vs normalized pipeline score. */
  blend: number;
};

export type IPSConfig = {
  enabled: boolean;
  epsilon: number;
  log_path: string;
};

export type ActivationConfig = {
  enabled: boolean;     // default true
  damping: number;      // default 0.6
  max_hops: number;     // default 2
  min_boost: number;    // default 0.01
};

export type WarmthConfig = {
  enabled: boolean;
  surprise_threshold: number;
  activation_threshold: number;
  ppr_alpha: number;
  ppr_iterations: number;
  graph_weight: number;
  max_results: number;
  shadow_compare_enabled: boolean;
};

export type ExploreConfig = {
  enabled: boolean;
  default_limit: number;
  max_limit: number;
  ppr_alpha: number;             // 0.45 — HippoRAG (NeurIPS 2024)
  ppr_iterations: number;
  seed_count: number;
  score_decay_threshold: number; // drop notes < this fraction of max PPR score
  max_depth: number;
  warmth_seed_blend: number;
  q_seed_blend: number;
  max_warmth_only_seeds: number;
  snippet_preview_length: number;
  snippet_max_links: number;
  cooc_blend_beta: number;
  // Phase 3: Recursion
  recursive_enabled: boolean;
  max_recursion_depth: number;
  max_total_notes: number;
  convergence_threshold: number;
  sub_question_max: number;
  ppr_iteration_decay: number;  // multiply PPR iterations per recursion depth
};

export type OriConfig = {
  vault: {
    version: string;
  };
  templates: TemplateMapping;
  vitality: VitalityConfig;
  llm: LlmConfig;
  promote: PromoteConfig;
  graph: GraphConfig;
  engine: EngineConfig;
  retrieval: RetrievalConfig;
  bm25: BM25Config;
  rerank: RerankConfig;
  ips: IPSConfig;
  activation: ActivationConfig;
  warmth: WarmthConfig;
  explore: ExploreConfig;
};

const DEFAULT_PROMOTE_CONFIG: PromoteConfig = {
  auto: true,
  require_llm: false,
  project_keywords: {},
  project_map_routing: {},
  default_area: "index",
};

const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  pagerank_alpha: 0.85,
  bridge_vitality_floor: 0.5,
  hub_degree_multiplier: 2.0,
};

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  embedding_model: "Xenova/all-MiniLM-L6-v2",
  embedding_dims: 384,
  piecewise_bins: 8,
  community_dims: 16,
  db_path: ".ori/embeddings.db",
};

const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  default_limit: 10,
  candidate_multiplier: 5,
  rrf_k: 60,
  signal_weights: {
    composite: 0.36,
    keyword: 0.18,
    graph: 0.26,
    warmth: 0.20,
  },
  exploration_budget: 0.10,
};

const DEFAULT_BM25_CONFIG: BM25Config = {
  k1: 1.2,
  b: 0.75,
  title_boost: 3.0,
  description_boost: 2.0,
};

const DEFAULT_RERANK_CONFIG: RerankConfig = {
  enabled: false,
  model: "Xenova/ms-marco-MiniLM-L-6-v2",
  top_k: 10,
  blend: 0.6,
};

const DEFAULT_IPS_CONFIG: IPSConfig = {
  enabled: true,
  epsilon: 0.01,
  log_path: "ops/access.jsonl",
};

const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  enabled: true,
  damping: 0.6,
  max_hops: 2,
  min_boost: 0.01,
};

const DEFAULT_WARMTH_CONFIG: WarmthConfig = {
  enabled: true,
  surprise_threshold: 0.15,
  activation_threshold: 0.35,
  ppr_alpha: 0.15,
  ppr_iterations: 20,
  graph_weight: 0.3,
  max_results: 20,
  shadow_compare_enabled: true,
};

const DEFAULT_EXPLORE_CONFIG: ExploreConfig = {
  enabled: true,
  default_limit: 15,
  max_limit: 30,
  ppr_alpha: 0.45,             // HippoRAG (NeurIPS 2024, arxiv 2405.14831)
  ppr_iterations: 30,
  seed_count: 10,
  score_decay_threshold: 0.15, // drop notes scoring < 15% of max PPR score
  max_depth: 2,
  warmth_seed_blend: 0.3,
  q_seed_blend: 0.15,
  max_warmth_only_seeds: 5,
  snippet_preview_length: 150,
  snippet_max_links: 8,
  cooc_blend_beta: 0.3,
  recursive_enabled: true,
  max_recursion_depth: 2,
  max_total_notes: 30,
  convergence_threshold: 0.15,
  sub_question_max: 3,
  ppr_iteration_decay: 0.67,
};

const DEFAULT_CONFIG: OriConfig = {
  vault: { version: "0.1" },
  templates: {
    default: "templates/note.md",
    by_type: {},
  },
  vitality: {
    decay: {},
    base: 1.0,
  },
  llm: { ...DEFAULT_LLM_CONFIG },
  promote: { ...DEFAULT_PROMOTE_CONFIG },
  graph: { ...DEFAULT_GRAPH_CONFIG },
  engine: { ...DEFAULT_ENGINE_CONFIG },
  retrieval: { ...DEFAULT_RETRIEVAL_CONFIG },
  bm25: { ...DEFAULT_BM25_CONFIG },
  rerank: { ...DEFAULT_RERANK_CONFIG },
  ips: { ...DEFAULT_IPS_CONFIG },
  activation: { ...DEFAULT_ACTIVATION_CONFIG },
  warmth: { ...DEFAULT_WARMTH_CONFIG },
  explore: { ...DEFAULT_EXPLORE_CONFIG },
};

export function applyConfigDefaults(raw: Partial<OriConfig>): OriConfig {
  const rawPromote = (raw as Record<string, unknown>).promote as
    | Partial<PromoteConfig>
    | undefined;
  const rawLlm = (raw as Record<string, unknown>).llm as
    | Partial<LlmConfig>
    | undefined;
  const rawGraph = (raw as Record<string, unknown>).graph as Partial<GraphConfig> | undefined;
  const rawEngine = (raw as Record<string, unknown>).engine as Partial<EngineConfig> | undefined;
  const rawRetrieval = (raw as Record<string, unknown>).retrieval as Partial<RetrievalConfig> | undefined;
  const rawBM25 = (raw as Record<string, unknown>).bm25 as Partial<BM25Config> | undefined;
  const rawRerank = (raw as Record<string, unknown>).rerank as Partial<RerankConfig> | undefined;
  const rawIPS = (raw as Record<string, unknown>).ips as Partial<IPSConfig> | undefined;
  const rawActivation = (raw as Record<string, unknown>).activation as Partial<ActivationConfig> | undefined;
  const rawWarmth = (raw as Record<string, unknown>).warmth as Partial<WarmthConfig> | undefined;
  const rawExplore = (raw as Record<string, unknown>).explore as Partial<ExploreConfig> | undefined;

  return {
    vault: {
      version: raw.vault?.version ?? DEFAULT_CONFIG.vault.version,
    },
    templates: {
      default: raw.templates?.default ?? DEFAULT_CONFIG.templates.default,
      by_type: raw.templates?.by_type ?? {},
    },
    vitality: {
      decay: raw.vitality?.decay ?? {},
      base: raw.vitality?.base ?? DEFAULT_CONFIG.vitality.base,
      model: (raw.vitality as Record<string, unknown> | undefined)?.model as string | undefined ?? "actr",
      actr_decay: (raw.vitality as Record<string, unknown> | undefined)?.actr_decay as number | undefined ?? 0.5,
      metabolic_rates: (raw.vitality as Record<string, unknown> | undefined)?.metabolic_rates as VitalityConfig["metabolic_rates"] | undefined ?? {
        self: 0.1,
        notes: 1.0,
        ops: 3.0,
      },
      structural_boost_per_link: (raw.vitality as Record<string, unknown> | undefined)?.structural_boost_per_link as number | undefined ?? 0.1,
      structural_boost_cap: (raw.vitality as Record<string, unknown> | undefined)?.structural_boost_cap as number | undefined ?? 10,
      revival_decay_rate: (raw.vitality as Record<string, unknown> | undefined)?.revival_decay_rate as number | undefined ?? 0.2,
      revival_window_days: (raw.vitality as Record<string, unknown> | undefined)?.revival_window_days as number | undefined ?? 14,
      access_saturation_k: (raw.vitality as Record<string, unknown> | undefined)?.access_saturation_k as number | undefined ?? 10,
      zone_thresholds: {
        active_floor: (raw.vitality as Record<string, unknown> | undefined)?.zone_thresholds
          ? ((raw.vitality as Record<string, unknown>).zone_thresholds as Record<string, unknown>)?.active_floor as number | undefined ?? 0.6
          : 0.6,
        stale_floor: (raw.vitality as Record<string, unknown> | undefined)?.zone_thresholds
          ? ((raw.vitality as Record<string, unknown>).zone_thresholds as Record<string, unknown>)?.stale_floor as number | undefined ?? 0.3
          : 0.3,
        fading_floor: (raw.vitality as Record<string, unknown> | undefined)?.zone_thresholds
          ? ((raw.vitality as Record<string, unknown>).zone_thresholds as Record<string, unknown>)?.fading_floor as number | undefined ?? 0.1
          : 0.1,
      },
    },
    llm: {
      provider: rawLlm?.provider ?? DEFAULT_LLM_CONFIG.provider,
      model: rawLlm?.model ?? DEFAULT_LLM_CONFIG.model,
      api_key_env: rawLlm?.api_key_env ?? DEFAULT_LLM_CONFIG.api_key_env,
      api_key_cmd: rawLlm?.api_key_cmd ?? DEFAULT_LLM_CONFIG.api_key_cmd,
      base_url: (rawLlm as Record<string, unknown> | undefined)?.base_url as string | null ?? DEFAULT_LLM_CONFIG.base_url,
    },
    promote: {
      auto: rawPromote?.auto ?? DEFAULT_PROMOTE_CONFIG.auto,
      require_llm: rawPromote?.require_llm ?? DEFAULT_PROMOTE_CONFIG.require_llm,
      project_keywords:
        rawPromote?.project_keywords ?? DEFAULT_PROMOTE_CONFIG.project_keywords,
      project_map_routing:
        rawPromote?.project_map_routing ??
        DEFAULT_PROMOTE_CONFIG.project_map_routing,
      default_area:
        rawPromote?.default_area ?? DEFAULT_PROMOTE_CONFIG.default_area,
    },
    graph: {
      pagerank_alpha: rawGraph?.pagerank_alpha ?? DEFAULT_GRAPH_CONFIG.pagerank_alpha,
      bridge_vitality_floor: rawGraph?.bridge_vitality_floor ?? DEFAULT_GRAPH_CONFIG.bridge_vitality_floor,
      hub_degree_multiplier: rawGraph?.hub_degree_multiplier ?? DEFAULT_GRAPH_CONFIG.hub_degree_multiplier,
    },
    engine: {
      embedding_model: rawEngine?.embedding_model ?? DEFAULT_ENGINE_CONFIG.embedding_model,
      embedding_dims: rawEngine?.embedding_dims ?? DEFAULT_ENGINE_CONFIG.embedding_dims,
      piecewise_bins: rawEngine?.piecewise_bins ?? DEFAULT_ENGINE_CONFIG.piecewise_bins,
      community_dims: rawEngine?.community_dims ?? DEFAULT_ENGINE_CONFIG.community_dims,
      db_path: rawEngine?.db_path ?? DEFAULT_ENGINE_CONFIG.db_path,
    },
    retrieval: {
      default_limit: rawRetrieval?.default_limit ?? DEFAULT_RETRIEVAL_CONFIG.default_limit,
      candidate_multiplier: rawRetrieval?.candidate_multiplier ?? DEFAULT_RETRIEVAL_CONFIG.candidate_multiplier,
      rrf_k: rawRetrieval?.rrf_k ?? DEFAULT_RETRIEVAL_CONFIG.rrf_k,
      signal_weights: {
        composite: rawRetrieval?.signal_weights?.composite ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.composite,
        keyword: rawRetrieval?.signal_weights?.keyword ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.keyword,
        graph: rawRetrieval?.signal_weights?.graph ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.graph,
        warmth: rawRetrieval?.signal_weights?.warmth ?? DEFAULT_RETRIEVAL_CONFIG.signal_weights.warmth,
      },
      exploration_budget: rawRetrieval?.exploration_budget ?? DEFAULT_RETRIEVAL_CONFIG.exploration_budget,
    },
    bm25: {
      k1: rawBM25?.k1 ?? DEFAULT_BM25_CONFIG.k1,
      b: rawBM25?.b ?? DEFAULT_BM25_CONFIG.b,
      title_boost: rawBM25?.title_boost ?? DEFAULT_BM25_CONFIG.title_boost,
      description_boost: rawBM25?.description_boost ?? DEFAULT_BM25_CONFIG.description_boost,
    },
    rerank: {
      enabled: rawRerank?.enabled ?? DEFAULT_RERANK_CONFIG.enabled,
      model: rawRerank?.model ?? DEFAULT_RERANK_CONFIG.model,
      top_k: rawRerank?.top_k ?? DEFAULT_RERANK_CONFIG.top_k,
      blend: rawRerank?.blend ?? DEFAULT_RERANK_CONFIG.blend,
    },
    ips: {
      enabled: rawIPS?.enabled ?? DEFAULT_IPS_CONFIG.enabled,
      epsilon: rawIPS?.epsilon ?? DEFAULT_IPS_CONFIG.epsilon,
      log_path: rawIPS?.log_path ?? DEFAULT_IPS_CONFIG.log_path,
    },
    activation: {
      enabled: rawActivation?.enabled ?? DEFAULT_ACTIVATION_CONFIG.enabled,
      damping: rawActivation?.damping ?? DEFAULT_ACTIVATION_CONFIG.damping,
      max_hops: rawActivation?.max_hops ?? DEFAULT_ACTIVATION_CONFIG.max_hops,
      min_boost: rawActivation?.min_boost ?? DEFAULT_ACTIVATION_CONFIG.min_boost,
    },
    warmth: {
      enabled: rawWarmth?.enabled ?? DEFAULT_WARMTH_CONFIG.enabled,
      surprise_threshold: rawWarmth?.surprise_threshold ?? DEFAULT_WARMTH_CONFIG.surprise_threshold,
      activation_threshold: rawWarmth?.activation_threshold ?? DEFAULT_WARMTH_CONFIG.activation_threshold,
      ppr_alpha: rawWarmth?.ppr_alpha ?? DEFAULT_WARMTH_CONFIG.ppr_alpha,
      ppr_iterations: rawWarmth?.ppr_iterations ?? DEFAULT_WARMTH_CONFIG.ppr_iterations,
      graph_weight: rawWarmth?.graph_weight ?? DEFAULT_WARMTH_CONFIG.graph_weight,
      max_results: rawWarmth?.max_results ?? DEFAULT_WARMTH_CONFIG.max_results,
      shadow_compare_enabled: rawWarmth?.shadow_compare_enabled ?? DEFAULT_WARMTH_CONFIG.shadow_compare_enabled,
    },
    explore: {
      enabled: rawExplore?.enabled ?? DEFAULT_EXPLORE_CONFIG.enabled,
      default_limit: rawExplore?.default_limit ?? DEFAULT_EXPLORE_CONFIG.default_limit,
      max_limit: rawExplore?.max_limit ?? DEFAULT_EXPLORE_CONFIG.max_limit,
      ppr_alpha: rawExplore?.ppr_alpha ?? DEFAULT_EXPLORE_CONFIG.ppr_alpha,
      ppr_iterations: rawExplore?.ppr_iterations ?? DEFAULT_EXPLORE_CONFIG.ppr_iterations,
      seed_count: rawExplore?.seed_count ?? DEFAULT_EXPLORE_CONFIG.seed_count,
      score_decay_threshold: rawExplore?.score_decay_threshold ?? DEFAULT_EXPLORE_CONFIG.score_decay_threshold,
      max_depth: rawExplore?.max_depth ?? DEFAULT_EXPLORE_CONFIG.max_depth,
      warmth_seed_blend: rawExplore?.warmth_seed_blend ?? DEFAULT_EXPLORE_CONFIG.warmth_seed_blend,
      q_seed_blend: rawExplore?.q_seed_blend ?? DEFAULT_EXPLORE_CONFIG.q_seed_blend,
      max_warmth_only_seeds: rawExplore?.max_warmth_only_seeds ?? DEFAULT_EXPLORE_CONFIG.max_warmth_only_seeds,
      snippet_preview_length: rawExplore?.snippet_preview_length ?? DEFAULT_EXPLORE_CONFIG.snippet_preview_length,
      snippet_max_links: rawExplore?.snippet_max_links ?? DEFAULT_EXPLORE_CONFIG.snippet_max_links,
      cooc_blend_beta: rawExplore?.cooc_blend_beta ?? DEFAULT_EXPLORE_CONFIG.cooc_blend_beta,
      recursive_enabled: rawExplore?.recursive_enabled ?? DEFAULT_EXPLORE_CONFIG.recursive_enabled,
      max_recursion_depth: rawExplore?.max_recursion_depth ?? DEFAULT_EXPLORE_CONFIG.max_recursion_depth,
      max_total_notes: rawExplore?.max_total_notes ?? DEFAULT_EXPLORE_CONFIG.max_total_notes,
      convergence_threshold: rawExplore?.convergence_threshold ?? DEFAULT_EXPLORE_CONFIG.convergence_threshold,
      sub_question_max: rawExplore?.sub_question_max ?? DEFAULT_EXPLORE_CONFIG.sub_question_max,
      ppr_iteration_decay: rawExplore?.ppr_iteration_decay ?? DEFAULT_EXPLORE_CONFIG.ppr_iteration_decay,
    },
  };
}

export function validateConfig(config: OriConfig): string[] {
  const errors: string[] = [];
  if (!config.vault.version) {
    errors.push("vault.version is required");
  }
  if (!config.templates.default) {
    errors.push("templates.default is required");
  }
  if (typeof config.vitality.base !== "number") {
    errors.push("vitality.base must be a number");
  }
  return errors;
}

export async function loadConfig(filePath: string): Promise<OriConfig> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return applyConfigDefaults({});
    }
    throw err;
  }
  const raw = yaml.parse(content) as Partial<OriConfig> | undefined;
  const config = applyConfigDefaults(raw ?? {});
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join(", ")}`);
  }
  return config;
}

export function resolveTemplatePath(
  config: OriConfig,
  vaultRoot: string,
  type: string | null
): string {
  const rel =
    (type && config.templates.by_type[type]) || config.templates.default;
  return path.resolve(vaultRoot, rel);
}
