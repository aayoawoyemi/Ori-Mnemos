import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 0.7.0 shipped with no `main`, no `exports` and no `types`, so
// `import { ... } from "ori-memory"` threw ERR_MODULE_NOT_FOUND for every
// consumer. All 25 core modules were in the tarball with .d.ts files and
// none of them were addressable. 324 stars, nobody could build on it.
//
// These assert the entry points a consumer actually hits.

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));

describe("package entry points", () => {
  it("resolves a bare import to the library barrel, not the CLI", async () => {
    expect(pkg.exports?.["."]).toBeDefined();
    const entry = pkg.exports["."].import;
    expect(entry).toBe("./dist/lib.js");

    // src/index.ts has a shebang and calls program.parse() at module load.
    // If "." ever points there, importing this package runs the CLI against
    // the host process's argv.
    expect(entry).not.toBe(pkg.bin.ori);
  });

  it("ships types with the import condition", () => {
    expect(pkg.types).toBe("./dist/lib.d.ts");
    expect(pkg.exports["."].types).toBe("./dist/lib.d.ts");
  });

  it("keeps the CLI bin separate from the library entry", () => {
    expect(pkg.bin.ori).toBe("./dist/index.js");
  });

  it("exports the documented public surface", async () => {
    const lib = await import("../../src/lib.js");
    // searchComposite is the same call the MCP ori_recall tool makes, so the
    // library path and the agent path cannot drift apart.
    for (const name of ["searchComposite", "openSyncedIndex", "runReadOnlySql", "loadConfig", "VERSION"]) {
      expect(lib, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("does not re-export all of core, which would freeze internals", async () => {
    const lib = await import("../../src/lib.js");
    // The surface is a semver contract. Anything reachable here is pinned.
    // If this fails, decide whether the new export is really public.
    expect(Object.keys(lib).length).toBeLessThanOrEqual(20);
  });
});
