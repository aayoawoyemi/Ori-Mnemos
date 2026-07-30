import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildAgentNotice,
  SessionNoticeGate,
  readUpdateDecision,
  writeUpdateDecision,
} from "../../src/core/update-check.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-notice-"));
  process.env.ORI_UPDATE_CACHE_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.ORI_UPDATE_CACHE_DIR;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("buildAgentNotice (ask-shaped, decision-aware)", () => {
  const info = { current: "0.6.1", latest: "0.7.0", updateAvailable: true, message: "update available" };

  it("returns null when updateAvailable is false", async () => {
    expect(await buildAgentNotice({ ...info, updateAvailable: false })).toBeNull();
  });

  it("returns null when message is null", async () => {
    expect(await buildAgentNotice({ ...info, message: null })).toBeNull();
  });

  it("asks a question and instructs the decision tool", async () => {
    const notice = await buildAgentNotice(info);
    expect(notice).toBeTypeOf("string");
    expect(notice!).toContain("0.7.0");
    expect(notice!).toContain("0.6.1");
    expect(notice!).toContain("?");
    expect(notice!).toContain("ori_update_decision");
    expect(notice!).toContain("npm update -g ori-memory");
    expect(notice!.toLowerCase()).toContain("resurface");
  });

  it("repeats until a decision exists, then goes silent for that version", async () => {
    expect(await buildAgentNotice(info)).not.toBeNull(); // session 1
    expect(await buildAgentNotice(info)).not.toBeNull(); // session 2 — no answer yet, still asks
    await writeUpdateDecision("0.7.0", "declined");
    expect(await buildAgentNotice(info)).toBeNull(); // answered — silent
  });

  it("a NEW version re-opens the question after a decline", async () => {
    await writeUpdateDecision("0.7.0", "declined");
    expect(await buildAgentNotice(info)).toBeNull();
    const newer = { ...info, latest: "0.8.0" };
    expect(await buildAgentNotice(newer)).not.toBeNull();
  });

  it("decision roundtrip persists", async () => {
    await writeUpdateDecision("0.7.0", "accepted");
    const d = await readUpdateDecision();
    expect(d?.version).toBe("0.7.0");
    expect(d?.decision).toBe("accepted");
  });
});

describe("SessionNoticeGate", () => {
  it("fires once per session; instances independent", () => {
    const a = new SessionNoticeGate();
    const b = new SessionNoticeGate();
    expect(a.take()).toBe(true);
    expect(a.take()).toBe(false);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});
