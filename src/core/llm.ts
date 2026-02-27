export type VaultContext = {
  existingTitles: string[];
  recentNotes: Array<{ title: string; type: string; description: string }>;
  projectTags: string[];
};

export type EnhancementSuggestions = {
  type?: string;
  description?: string;
  links?: string[];
  project?: string[];
  areas?: string[];
  reasoning?: string;
};

export type LlmConfig = {
  provider: string | null;
  model: string | null;
  api_key_env: string | null;
  base_url: string | null;
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: null,
  model: null,
  api_key_env: null,
  base_url: null,
};

export interface LlmProvider {
  enhance(
    note: {
      title: string;
      body: string;
      frontmatter: Record<string, unknown>;
    },
    context: VaultContext
  ): Promise<EnhancementSuggestions>;
}

/**
 * Null provider: returns empty suggestions (pure deterministic path).
 */
export class NullProvider implements LlmProvider {
  async enhance(): Promise<EnhancementSuggestions> {
    return {};
  }
}

/**
 * Create provider from config. Returns NullProvider when provider is null.
 */
export async function createProvider(config: LlmConfig): Promise<LlmProvider> {
  if (!config.provider) {
    return new NullProvider();
  }

  const apiKey = config.api_key_env
    ? process.env[config.api_key_env]
    : undefined;

  if (!apiKey) {
    return new NullProvider();
  }

  switch (config.provider) {
    case "anthropic": {
      const { AnthropicProvider } = await import("../providers/anthropic.js");
      return new AnthropicProvider(
        apiKey,
        config.model ?? "claude-sonnet-4-20250514"
      );
    }
    case "openai": {
      const { OpenAICompatProvider } = await import("../providers/openai-compat.js");
      return new OpenAICompatProvider(
        apiKey,
        config.model ?? "gpt-4o",
        config.base_url
      );
    }
    default:
      return new NullProvider();
  }
}
