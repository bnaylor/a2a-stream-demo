import { describe, expect, it } from "vitest";
import { makeHeartbeat } from "./heartbeat.ts";

describe("heartbeat", () => {
  it("builds Synadia-compatible payloads (spec §3.2 keys)", () => {
    const hb = makeHeartbeat(
      { agentType: "claude-code", owner: "bnaylor", session: "chatops", instanceId: "i-1" },
      new Date("2026-08-19T21:00:00Z"),
    );
    expect(hb).toEqual({
      agent: "claude-code",
      owner: "bnaylor",
      session: "chatops",
      instance_id: "i-1",
      ts: "2026-08-19T21:00:00.000Z",
      interval_s: 15,
    });
  });
});
