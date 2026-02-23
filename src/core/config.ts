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
};

export type PromoteConfig = {
  auto: boolean;
  require_llm: boolean;
  min_confidence: number;
  project_keywords: Record<string, string[]>;
  project_map_routing: Record<string, string>;
  default_area: string;
};

export type OriConfig = {
  vault: {
    version: string;
  };
  templates: TemplateMapping;
  vitality: VitalityConfig;
  llm: LlmConfig;
  promote: PromoteConfig;
};

const DEFAULT_PROMOTE_CONFIG: PromoteConfig = {
  auto: true,
  require_llm: false,
  min_confidence: 0.6,
  project_keywords: {},
  project_map_routing: {},
  default_area: "index",
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
};

export function applyConfigDefaults(raw: Partial<OriConfig>): OriConfig {
  const rawPromote = (raw as Record<string, unknown>).promote as
    | Partial<PromoteConfig>
    | undefined;
  const rawLlm = (raw as Record<string, unknown>).llm as
    | Partial<LlmConfig>
    | undefined;

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
    },
    llm: {
      provider: rawLlm?.provider ?? DEFAULT_LLM_CONFIG.provider,
      model: rawLlm?.model ?? DEFAULT_LLM_CONFIG.model,
      api_key_env: rawLlm?.api_key_env ?? DEFAULT_LLM_CONFIG.api_key_env,
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