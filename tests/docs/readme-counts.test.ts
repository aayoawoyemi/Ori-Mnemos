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

  // A tool the README *offers* but serve.ts does not register is worse than a
  // wrong total: an agent reading the table will call it and get an error.
  //
  // Scoped to table rows, not the whole file. The first version of this test
  // checked every mention and immediately failed on the migration table that
  // documents which tools were removed and what replaced them -- naming a
  // dead tool in order to say it is dead is the opposite of the failure being
  // guarded against. A row is `| \`ori_x\` | description |`; prose is prose.
  it("offers no tool in its table that is not registered", () => {
    // The README holds two tables of the same shape: what is offered, and a
    // migration table naming removed tools so readers can find the
    // replacement. Naming a dead tool to say it is dead is the opposite of
    // the failure being guarded against, so the scan stops where the
    // removal section begins.
    const start = readme.indexOf("## MCP Tools");
    const end = readme.indexOf("Five tools were removed", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const registered = new Set(serve.match(/ori_[a-z_]+/g) ?? []);
    const offered = [
      ...readme.slice(start, end).matchAll(/^\|\s*`(ori_[a-z_]+|memory_sql)`\s*\|/gm),
    ].map((m) => m[1]);

    expect(offered.length).toBeGreaterThan(5);
    const phantom = [...new Set(offered)].filter(
      (t) => t !== "memory_sql" && !registered.has(t),
    );
    expect(phantom).toEqual([]);
  });
});
