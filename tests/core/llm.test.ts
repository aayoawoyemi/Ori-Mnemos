import { describe, it, expect } from "vitest";
import {
  NullProvider,
  createProvider,
  DEFAULT_LLM_CONFIG,
  type LlmConfig,
} from "../../src/core/llm.js";

describe("NullProvider", () => {
  it("returns empty suggestions", async () => {
    const provider = new NullProvider();
    const result = await provider.enhance(
      { title: "test", body: "content", frontmatter: {} },
      { existingTitles: [], recentNotes: [], projectTags: [] }
    );
    expect(result).toEqual({});
  });
});

describe("createProvider", () => {
  it("returns NullProvider when provider is null", async () => {
    const provider = await createProvider(DEFAULT_LLM_CONFIG);
    expect(provider).toBeInstanceOf(NullProvider);
  });

  it("returns NullProvider when provider is set but API key env is missing", async () => {
    const config: LlmConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      api_key_env: "NONEXISTENT_KEY_FOR_TEST",
    };
    const provider = await createProvider(config);
    // Should fallback to NullProvider since env var doesn't exist
    expect(provider).toBeInstanceOf(NullProvider);
  });

  it("returns NullProvider for unknown provider", async () => {
    const config: LlmConfig = {
      provider: "unknown-provider",
      model: null,
      api_key_env: null,
    };
    const provider = await createProvider(config);
    expect(provider).toBeInstanceOf(NullProvider);
  });
});

describe("DEFAULT_LLM_CONFIG", () => {
  it("has null provider by default", () => {
    expect(DEFAULT_LLM_CONFIG.provider).toBeNull();
    expect(DEFAULT_LLM_CONFIG.model).toBeNull();
    expect(DEFAULT_LLM_CONFIG.api_key_env).toBeNull();
  });
});
