import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";

export type FrontmatterParseResult = {
  data: Record<string, unknown> | null;
  body: string;
  errors: string[];
};

const FRONTMATTER_BOUNDARY = "---";

export function parseFrontmatter(content: string): FrontmatterParseResult {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);
  if (lines[0] !== FRONTMATTER_BOUNDARY) {
    return { data: null, body: content, errors };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FRONTMATTER_BOUNDARY) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { data: null, body: content, errors: ["Unterminated frontmatter"] };
  }

  const raw = lines.slice(1, endIndex).join("\n");
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = yaml.parse(raw);
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    } else {
      data = {};
    }
  } catch (err) {
    errors.push(`Invalid YAML frontmatter: ${(err as Error).message}`);
  }

  const body = lines.slice(endIndex + 1).join("\n");
  return { data, body, errors };
}

export function stringifyFrontmatter(
  data: Record<string, unknown>,
  body: string
): string {
  const doc = yaml.stringify(data).trimEnd();
  if (doc.length === 0) {
    return body;
  }
  const normalizedBody = body.startsWith("\n") ? body.slice(1) : body;
  return `${FRONTMATTER_BOUNDARY}\n${doc}\n${FRONTMATTER_BOUNDARY}\n${normalizedBody}`;
}

export async function readFrontmatterFile(
  filePath: string
): Promise<FrontmatterParseResult> {
  const content = await fs.readFile(filePath, "utf8");
  return parseFrontmatter(content);
}

export async function writeFrontmatterFile(
  filePath: string,
  data: Record<string, unknown>,
  body: string
): Promise<void> {
  const content = stringifyFrontmatter(data, body);
  await fs.writeFile(filePath, content, "utf8");
}

export async function writeTempFrontmatter(
  data: Record<string, unknown>,
  body: string
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-frontmatter-"));
  const filePath = path.join(dir, "note.md");
  await writeFrontmatterFile(filePath, data, body);
  return filePath;
}