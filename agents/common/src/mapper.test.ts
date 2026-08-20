import { describe, expect, it } from "vitest";
import { mapSdkMessage } from "./mapper.ts";

const ctx = {
  taskId: "task-1",
  contextId: "ctx-1",
  correlationId: "corr-1",
  from: { session: "worker-brisk-otter", agentType: "claude-code" },
};

describe("mapSdkMessage", () => {
  it("maps text deltas to message-chunk", () => {
    const out = mapSdkMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        },
      },
      ctx
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("message-chunk");
    expect(out[0].correlationId).toBe("corr-1");
  });

  it("prefixes thinking deltas", () => {
    const out = mapSdkMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      },
      ctx
    );
    expect(
      (out[0].payload as { parts: { text: string }[] }).parts[0].text
    ).toBe("[thinking] hmm");
  });

  it("maps tool_use to working status with tool metadata", () => {
    const out = mapSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "WebSearch" },
            { type: "text", text: "x" },
          ],
        },
      },
      ctx
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("status-update");
  });

  it("maps success result to artifact then final completed", () => {
    const out = mapSdkMessage(
      { type: "result", subtype: "success", result: "42" },
      ctx
    );
    expect(out.map((e) => e.kind)).toEqual([
      "artifact-update",
      "status-update",
    ]);
  });

  it("maps error results to final failed", () => {
    const out = mapSdkMessage(
      { type: "result", subtype: "error_max_turns" },
      ctx
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("status-update");
  });

  it("ignores unknown messages", () => {
    expect(
      mapSdkMessage({ type: "system", subtype: "init" }, ctx)
    ).toEqual([]);
  });
});
