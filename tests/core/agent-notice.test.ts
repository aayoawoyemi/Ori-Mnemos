import { describe, it, expect } from "vitest";
import { buildAgentNotice, SessionNoticeGate } from "../../src/core/update-check.js";

describe("buildAgentNotice", () => {
  it("returns null when updateAvailable is false", () => {
    const info = { current: "1.0.0", latest: "2.0.0", updateAvailable: false, message: "any" };
    expect(buildAgentNotice(info)).toBeNull();
  });

  it("returns null when message is null", () => {
    const info = { current: "1.0.0", latest: "2.0.0", updateAvailable: true, message: null };
    expect(buildAgentNotice(info)).toBeNull();
  });

  it("returns a proper notice string when updateAvailable and message", () => {
    const info = { current: "1.0.0", latest: "2.0.0", updateAvailable: true, message: "update available" };
    const notice = buildAgentNotice(info);
    expect(notice).toBeTypeOf("string");
    expect(notice.length).toBeGreaterThan(0);
    expect(notice).toContain("1.0.0");
    expect(notice).toContain("2.0.0");
    expect(notice).toContain("npm update -g ori-memory");
    expect(notice.toLowerCase()).toContain("user");
  });
});

describe("SessionNoticeGate", () => {
  it("toggles correctly and instances are independent", () => {
    const gateA = new SessionNoticeGate();
    const gateB = new SessionNoticeGate();

    expect(gateA.take()).toBe(true);
    expect(gateA.take()).toBe(false);
    expect(gateA.take()).toBe(false);

    expect(gateB.take()).toBe(true);
    expect(gateB.take()).toBe(false);
    expect(gateB.take()).toBe(false);

    expect(gateA.take()).toBe(false);
    expect(gateB.take()).toBe(false);
  });
});