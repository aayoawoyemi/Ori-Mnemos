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
};

export type PromoteConfig = {
  auto: boolean;
  require_llm: boolean;
  min_confidence: number;
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
  };
  exploration_budget: number;
};

export type BM25Config = {
  k1: number;
  b: number;
  title_boost: number;
  description_boost: number;
};

export type IPSConfig = {
  enabled: boolean;
  epsilon: number;
  log_path: string;
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
  ips: IPSConfig;
};

const DEFAULT_PROMOTE_CONFIG: PromoteConfig = {
  auto: true,
  require_llm: false,
  min_confidence: 0.6,
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
    composite: 2.0,
    keyword: 1.0,
    graph: 1.5,
  },
  exploration_budget: 0.10,
};

const DEFAULT_BM25_CONFIG: BM25Config = {
  k1: 1.2,
  b: 0.75,
  title_boost: 3.0,
  description_boost: 2.0,
};

const DEFAULT_IPS_CONFIG: IPSConfig = {
  enabled: true,
  epsilon: 0.01,
  log_path: "ops/access.jsonl",
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
  ips: { ...DEFAULT_IPS_CONFIG },
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
  const rawIPS = (raw as Record<string, unknown>).ips as Partial<IPSConfig> | undefined;

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
    },
    llm: {
      provider: rawLlm?.provider ?? DEFAULT_LLM_CONFIG.provider,
      model: rawLlm?.model ?? DEFAULT_LLM_CONFIG.model,
      api_key_env: rawLlm?.api_key_env ?? DEFAULT_LLM_CONFIG.api_key_env,
      base_url: (rawLlm as Record<string, unknown> | undefined)?.base_url as string | null ?? DEFAULT_LLM_CONFIG.base_url,
    },
    promote: {
      auto: rawPromote?.auto ?? DEFAULT_PROMOTE_CONFIG.auto,
      require_llm: rawPromote?.require_llm ?? DEFAULT_PROMOTE_CONFIG.require_llm,
      min_confidence:
        rawPromote?.min_confidence ?? DEFAULT_PROMOTE_CONFIG.min_confidence,
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
      },
      exploration_budget: rawRetrieval?.exploration_budget ?? DEFAULT_RETRIEVAL_CONFIG.exploration_budget,
    },
    bm25: {
      k1: rawBM25?.k1 ?? DEFAULT_BM25_CONFIG.k1,
      b: rawBM25?.b ?? DEFAULT_BM25_CONFIG.b,
      title_boost: rawBM25?.title_boost ?? DEFAULT_BM25_CONFIG.title_boost,
      description_boost: rawBM25?.description_boost ?? DEFAULT_BM25_CONFIG.description_boost,
    },
    ips: {
      enabled: rawIPS?.enabled ?? DEFAULT_IPS_CONFIG.enabled,
      epsilon: rawIPS?.epsilon ?? DEFAULT_IPS_CONFIG.epsilon,
      log_path: rawIPS?.log_path ?? DEFAULT_IPS_CONFIG.log_path,
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