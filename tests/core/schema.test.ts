import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadTemplateSchema,
  validateNoteAgainstSchema,
} from "../../src/core/schema.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-test-schema-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function templateContent(schema: Record<string, unknown>): string {
  const schemaYaml = Object.entries(schema)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `    ${k}:\n${v.map((i) => `      - ${i}`).join("\n")}`;
      }
      if (typeof v === "object" && v !== null) {
        const inner = Object.entries(v as Record<string, unknown>)
          .map(([ik, iv]) => {
            if (typeof iv === "object" && iv !== null && !Array.isArray(iv)) {
              const deep = Object.entries(iv as Record<string, unknown>)
                .map(([dk, dv]) => `        ${dk}: ${dv}`)
                .join("\n");
              return `      ${ik}:\n${deep}`;
            }
            if (Array.isArray(iv)) {
              return `      ${ik}:\n${iv.map((i) => `        - ${i}`).join("\n")}`;
            }
            return `      ${ik}: ${iv}`;
          })
          .join("\n");
        return `    ${k}:\n${inner}`;
      }
      return `    ${k}: ${v}`;
    })
    .join("\n");
  return `---\n_schema:\n${schemaYaml}\n---\nTemplate body.`;
}

function noteContent(data: Record<string, unknown>, body = "Note body."): string {
  const yamlLines = Object.entries(data).map(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return `${k}: []`;
      return `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
    }
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `---\n${yamlLines.join("\n")}\n---\n${body}`;
}

describe("loadTemplateSchema", () => {
  it("extracts _schema from template frontmatter", async () => {
    const tmplPath = path.join(tmpDir, "note.md");
    await fs.writeFile(
      tmplPath,
      '---\n_schema:\n  entity_type: "note"\n  required:\n    - description\n    - type\n---\nTemplate.',
      "utf8"
    );
    const schema = await loadTemplateSchema(tmplPath);
    expect(schema.entity_type).toBe("note");
    expect(schema.required).toEqual(["description", "type"]);
  });

  it("returns empty object when no _schema key", async () => {
    const tmplPath = path.join(tmpDir, "bare.md");
    await fs.writeFile(tmplPath, "---\ntitle: bare\n---\nBody.", "utf8");
    const schema = await loadTemplateSchema(tmplPath);
    expect(schema).toEqual({});
  });
});

describe("validateNoteAgainstSchema", () => {
  it("passes for note meeting all required fields", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(
      tmplPath,
      '---\n_schema:\n  required:\n    - description\n    - type\n---\n',
      "utf8"
    );
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(
      notePath,
      noteContent({ description: "A note", type: "insight" }),
      "utf8"
    );
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("errors on missing required field", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(
      tmplPath,
      "---\n_schema:\n  required:\n    - description\n    - type\n---\n",
      "utf8"
    );
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(
      notePath,
      noteContent({ description: "Has description" }),
      "utf8"
    );
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: type");
  });

  it("errors on missing frontmatter", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(tmplPath, "---\n_schema:\n  required:\n    - type\n---\n", "utf8");
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(notePath, "No frontmatter here.", "utf8");
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing YAML frontmatter");
  });

  it("errors on invalid enum value", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(
      tmplPath,
      '---\n_schema:\n  required:\n    - type\n  enums:\n    type:\n      - idea\n      - insight\n---\n',
      "utf8"
    );
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(
      notePath,
      noteContent({ type: "invalid-type" }),
      "utf8"
    );
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid type value/);
  });

  it("validates array enum values", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(
      tmplPath,
      '---\n_schema:\n  enums:\n    tags:\n      - a\n      - b\n      - c\n---\n',
      "utf8"
    );
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(
      notePath,
      noteContent({ tags: ["a", "x"] }),
      "utf8"
    );
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid tags values/);
  });

  it("errors on description exceeding max_length", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(
      tmplPath,
      "---\n_schema:\n  constraints:\n    description:\n      max_length: 10\n---\n",
      "utf8"
    );
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(
      notePath,
      noteContent({ description: "This is way too long for the limit" }),
      "utf8"
    );
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exceeds max length/);
  });

  it("warns on description ending with period", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(
      tmplPath,
      "---\n_schema:\n  constraints:\n    description:\n      max_length: 200\n---\n",
      "utf8"
    );
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(
      notePath,
      noteContent({ description: "Ends with period." }),
      "utf8"
    );
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      "Description should not end with a period"
    );
  });

  it("skips enum validation for blank fields", async () => {
    const tmplPath = path.join(tmpDir, "tmpl.md");
    await fs.writeFile(
      tmplPath,
      '---\n_schema:\n  enums:\n    type:\n      - idea\n      - insight\n---\n',
      "utf8"
    );
    const notePath = path.join(tmpDir, "note.md");
    await fs.writeFile(notePath, noteContent({ type: "" }), "utf8");
    const result = await validateNoteAgainstSchema(notePath, tmplPath);
    // Blank field should not trigger enum validation error
    expect(result.errors.filter((e) => e.includes("Invalid type"))).toEqual([]);
  });
});
