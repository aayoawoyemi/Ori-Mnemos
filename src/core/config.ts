import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "yaml";

export type TemplateMapping = {
  default: string;
  by_type: Record<string, string>;
};

export type VitalityConfig = {
  decay: Record<string, number>;
  base: number;
};

export type OriConfig = {
  vault: {
    version: string;
  };
  templates: TemplateMapping;
  vitality: VitalityConfig;
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
};

export function applyConfigDefaults(raw: Partial<OriConfig>): OriConfig {
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