import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The README advertised "16 tools" while serve.ts registered 21, and "17 CLI
// commands" against 18. Nobody noticed across five tool additions. For a repo
// whose README is the product surface, an undercount is not cosmetic -- it is
// a published claim that five capabilities do not exist.
//
// Counted here rather than asserted as literals so adding a tool fails this
// test until the README is updated, which is the only mechanism that has ever
// kept these honest.
//
// Deliberately NOT asserted: the test count. It changes on every commit, so
// pinning it would produce a failure that means nothing and trains people to
// edit the number without reading it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const readme = read("README.md");
const serve = read("src/cli/serve.ts");
const index = read("src/index.ts");

const toolCount = new Set(serve.match(/ori_[a-z_]+/g) ?? []).size;
const resourceCount = (serve.match(/server\.resource\(/g) ?? []).length;
const commandCount = (index.match(/^\s*\.command\(/gm) ?? []).length;

describe("README advertises the surface that exists", () => {
  it("states the registered MCP tool count everywhere it appears", () => {
    const claims = [...readme.matchAll(/(\d+)\s+(?:MCP\s+)?tools/g)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(toolCount);
  });

  it("states the registered resource count", () => {
    const claims = [...readme.matchAll(/(\d+)\s+resources/g)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(resourceCount);
  });

  it("states the registered CLI command count", () => {
    const claims = [...readme.matchAll(/(\d+)\s+CLI commands/g)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(commandCount);
  });

  // A tool the README names but serve.ts does not register is worse than a
  // wrong total: an agent reading the docs will call it and get an error.
  it("names no tool that is not registered", () => {
    const named = new Set(readme.match(/\bori_[a-z_]+/g) ?? []);
    const registered = new Set(serve.match(/ori_[a-z_]+/g) ?? []);
    const phantom = [...named].filter((t) => !registered.has(t));
    expect(phantom).toEqual([]);
  });
});
