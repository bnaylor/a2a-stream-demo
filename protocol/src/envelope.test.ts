import { describe, expect, it } from "vitest";
import {
  EnvelopeError, PROTOCOL_VERSION, encodeEnvelope, makeEnvelope, parseEnvelope,
} from "./envelope.ts";

const from = { session: "chatops", agentType: "claude-code" };

describe("envelope", () => {
  it("round-trips through encode/parse", () => {
    const env = makeEnvelope({
      kind: "status-update",
      correlationId: "corr-1", taskId: "task-1", contextId: "ctx-1",
      from, payload: { taskId: "task-1", contextId: "ctx-1",
        status: { state: "working", timestamp: "2026-08-19T21:00:00Z" }, final: false },
    });
    expect(env.protocol).toBe(PROTOCOL_VERSION);
    expect(Date.parse(env.ts)).not.toBeNaN();
    expect(parseEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it("requires taskId/contextId for task-scoped kinds", () => {
    expect(() =>
      makeEnvelope({ kind: "message-chunk", correlationId: "corr-1", from, payload: {} }),
    ).toThrow(EnvelopeError);
  });

  it("allows agent-card without taskId", () => {
    const env = makeEnvelope({ kind: "agent-card", correlationId: "corr-1", from, payload: { name: "chatops" } });
    expect(env.taskId).toBeUndefined();
  });

  it.each([
    ["not json", "{"],
    ["wrong protocol", JSON.stringify({ protocol: "a2a-jetstream/9.9" })],
    ["missing from", JSON.stringify({ protocol: PROTOCOL_VERSION, correlationId: "c", ts: "t", kind: "agent-card", payload: {} })],
    ["bad kind", JSON.stringify({ protocol: PROTOCOL_VERSION, correlationId: "c", ts: "t", kind: "nope", from: { session: "s", agentType: "a" }, payload: {} })],
  ])("rejects invalid input: %s", (_name, raw) => {
    expect(() => parseEnvelope(raw)).toThrow(EnvelopeError);
  });

  it("ignores unknown fields (forward compat)", () => {
    const raw = JSON.stringify({
      protocol: PROTOCOL_VERSION, correlationId: "c", ts: "2026-08-19T21:00:00Z",
      kind: "agent-card", from, payload: {}, futureField: 42,
    });
    expect(parseEnvelope(raw).kind).toBe("agent-card");
  });
});
