import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  encodeEnvelope,
  parseEnvelope,
} from "@a2a-demo/protocol/src/envelope.ts";
import { taskRequestSubject } from "@a2a-demo/protocol/src/subjects.ts";
import { CHATOPS_SESSION, WEB_SESSION } from "./model.ts";
import { buildChatTask } from "./submit.ts";

describe("buildChatTask", () => {
  it("builds a task envelope addressed to chatops", () => {
    const { env } = buildChatTask("what is otter doing?");
    expect(env.protocol).toBe(PROTOCOL_VERSION);
    expect(env.kind).toBe("task");
    expect(env.to).toEqual({ session: CHATOPS_SESSION });
    expect(env.from).toEqual({ session: WEB_SESSION, agentType: "human" });
  });

  it("carries the prompt and a submitted status in the payload", () => {
    const { env, taskId } = buildChatTask("hello");
    const payload = env.payload as {
      id: string;
      contextId: string;
      prompt: string;
      status: { state: string; timestamp: string };
    };
    expect(payload.prompt).toBe("hello");
    expect(payload.id).toBe(taskId);
    expect(payload.contextId).toBe(env.contextId);
    expect(payload.status.state).toBe("submitted");
    expect(Number.isNaN(Date.parse(payload.status.timestamp))).toBe(false);
  });

  it("returns ids that match the protocol prefixes", () => {
    const { env, taskId, correlationId } = buildChatTask("hi");
    expect(taskId).toMatch(/^task-[0-9a-f-]{36}$/);
    expect(correlationId).toMatch(/^corr-[0-9a-f-]{36}$/);
    expect(env.contextId).toMatch(/^ctx-[0-9a-f-]{36}$/);
    expect(env.taskId).toBe(taskId);
    expect(env.correlationId).toBe(correlationId);
  });

  it("mints fresh ids on every call", () => {
    const a = buildChatTask("hi");
    const b = buildChatTask("hi");
    expect(a.taskId).not.toBe(b.taskId);
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.env.contextId).not.toBe(b.env.contextId);
  });

  it("produces an envelope that survives an encode/parse round trip", () => {
    const { env, taskId } = buildChatTask("round trip");
    const back = parseEnvelope(encodeEnvelope(env));
    expect(back.kind).toBe("task");
    expect(back.taskId).toBe(taskId);
    expect(back.to?.session).toBe(CHATOPS_SESSION);
  });

  it("yields a task id usable as a request subject token", () => {
    const { taskId } = buildChatTask("hi");
    expect(taskRequestSubject(taskId)).toBe(`a2a.tasks.${taskId}.request`);
  });
});
