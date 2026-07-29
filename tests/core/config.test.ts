import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyConfigDefaults,
  validateConfig,
  loadConfig,
  resolveTemplatePath,
  type OriConfig,
} from "../../src/core/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-test-cfg-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("applyConfigDefaults", () => {
  it("returns full defaults for empty input", () => {
    const config = applyConfigDefaults({});
    expect(config.vault.version).toBe("0.1");
    expect(config.templates.default).toBe("templates/note.md");
    expect(config.templates.by_type).toEqual({});
    expect(config.vitality.decay).toEqual({});
    expect(config.vitality.base).toBe(1.0);
    expect(config.warmth.enabled).toBe(true);
    expect(config.retrieval.signal_weights.warmth).toBe(0.20);
  });

  it("preserves provided values while filling missing ones", () => {
    const config = applyConfigDefaults({
      vault: { version: "0.2" },
      vitality: { decay: { insight: 30 }, base: 2.0 },
    });
    expect(config.vault.version).toBe("0.2");
    expect(config.templates.default).toBe("templates/note.md");
    expect(config.vitality.decay).toEqual({ insight: 30 });
    expect(config.vitality.base).toBe(2.0);
  });

  it("handles partial templates override", () => {
    const config = applyConfigDefaults({
      templates: { default: "custom/tmpl.md", by_type: { map: "custom/map.md" } },
    });
    expect(config.templates.default).toBe("custom/tmpl.md");
    expect(config.templates.by_type).toEqual({ map: "custom/map.md" });
  });
});

describe("validateConfig", () => {
  it("returns no errors for valid config", () => {
    const config = applyConfigDefaults({});
    expect(validateConfig(config)).toEqual([]);
  });

  it("returns error for empty vault.version", () => {
    const config = applyConfigDefaults({});
    config.vault.version = "";
    const errors = validateConfig(config);
    expect(errors).toContain("vault.version is required");
  });

  it("returns error for empty templates.default", () => {
    const config = applyConfigDefaults({});
    config.templates.default = "";
    const errors = validateConfig(config);
    expect(errors).toContain("templates.default is required");
  });

  it("returns error for non-number vitality.base", () => {
    const config = applyConfigDefaults({});
    (config.vitality as Record<string, unknown>).base = "not a number";
    const errors = validateConfig(config);
    expect(errors).toContain("vitality.base must be a number");
  });

  it("returns multiple errors when multiple fields invalid", () => {
    const config = {
      vault: { version: "" },
      templates: { default: "", by_type: {} },
      vitality: { decay: {}, base: NaN },
    } as OriConfig;
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadConfig", () => {
  it("returns defaults when file does not exist", async () => {
    const config = await loadConfig(path.join(tmpDir, "missing.yaml"));
    expect(config.vault.version).toBe("0.1");
    expect(config.templates.default).toBe("templates/note.md");
  });

  it("loads and parses a valid YAML config", async () => {
    const configPath = path.join(tmpDir, "ori.config.yaml");
    await fs.writeFile(
      configPath,
      "vault:\n  version: '0.2'\nvitality:\n  base: 2.0\n  decay:\n    insight: 45\n",
      "utf8"
    );
    const config = await loadConfig(configPath);
    expect(config.vault.version).toBe("0.2");
    expect(config.vitality.base).toBe(2.0);
    expect(config.vitality.decay.insight).toBe(45);
    expect(config.templates.default).toBe("templates/note.md");
  });

  it("throws for invalid config", async () => {
    const configPath = path.join(tmpDir, "bad.yaml");
    await fs.writeFile(
      configPath,
      "vault:\n  version: ''\ntemplates:\n  default: ''\n",
      "utf8"
    );
    await expect(loadConfig(configPath)).rejects.toThrow("Invalid config");
  });
});

describe("api_key_cmd config", () => {
  it("defaults api_key_cmd to null", () => {
    const config = applyConfigDefaults({});
    expect(config.llm.api_key_cmd).toBeNull();
  });

  it("preserves api_key_cmd when provided", () => {
    const config = applyConfigDefaults({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        api_key_env: null,
        api_key_cmd: "pass anthropic/api-key",
        base_url: null,
      },
    });
    expect(config.llm.api_key_cmd).toBe("pass anthropic/api-key");
  });

  it("loads api_key_cmd from YAML config", async () => {
    const configPath = path.join(tmpDir, "ori.config.yaml");
    await fs.writeFile(
      configPath,
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514\n  api_key_cmd: \"pass anthropic/api-key\"\n",
      "utf8"
    );
    const config = await loadConfig(configPath);
    expect(config.llm.api_key_cmd).toBe("pass anthropic/api-key");
  });
});

describe("resolveTemplatePath", () => {
  const config = applyConfigDefaults({
    templates: {
      default: "templates/note.md",
      by_type: { map: "templates/map.md", source: "templates/source.md" },
    },
  });

  it("resolves by_type mapping when type matches", () => {
    const result = resolveTemplatePath(config, "/vault", "map");
    expect(result).toBe(path.resolve("/vault", "templates/map.md"));
  });

  it("falls back to default when type not in by_type", () => {
    const result = resolveTemplatePath(config, "/vault", "unknown-type");
    expect(result).toBe(path.resolve("/vault", "templates/note.md"));
  });

  it("falls back to default when type is null", () => {
    const result = resolveTemplatePath(config, "/vault", null);
    expect(result).toBe(path.resolve("/vault", "templates/note.md"));
  });
});

describe("retrieval stage budget defaults (#34)", () => {
  it("defaults", () => {
    const cfg = applyConfigDefaults({});
    expect(cfg.retrieval.stage_time_budget_ms).toBe(500);
    expect(cfg.retrieval.stage_soft_cutoff).toBe(0.8);
  });

  it("preserves user values", () => {
    const input = {
      retrieval: {
        stage_time_budget_ms: 5_000,
        stage_soft_cutoff: 0.5,
      },
    } as any;
    const cfg = applyConfigDefaults(input);
    expect(cfg.retrieval.stage_time_budget_ms).toBe(5_000);
    expect(cfg.retrieval.stage_soft_cutoff).toBe(0.5);
  });
});
