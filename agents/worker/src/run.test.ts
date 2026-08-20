import { describe, expect, it } from "vitest";
import { runWorker } from "./run.ts";
import { makeEnvelope, Envelope } from "@a2a-demo/protocol";

const ctx = { taskId: "task-1", contextId: "ctx-1", correlationId: "corr-1",
  from: { session: "worker-x", agentType: "claude-code" } };

const taskEnv = makeEnvelope({
  kind: "task", correlationId: "corr-1", taskId: "task-1", contextId: "ctx-1",
  from: { session: "chatops", agentType: "claude-code" },
  payload: { id: "task-1", contextId: "ctx-1",
    status: { state: "submitted", timestamp: "2026-08-19T21:00:00Z" },
    prompt: "count to three" },
});

async function* fakeStream() {
  yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "1 2 3" } } };
  yield { type: "result", subtype: "success", result: "1 2 3" };
}

describe("runWorker", () => {
  it("publishes working, streams events, ends completed, exits 0", async () => {
    const published: Envelope[] = [];
    const code = await runWorker({
      fetchTask: async () => taskEnv,
      publishEvent: async (e) => { published.push(e); },
      queryStream: () => fakeStream(),
      ctx,
    });
    expect(code).toBe(0);
    expect(published[0].kind).toBe("status-update"); // working
    expect(published.map((e) => e.kind)).toEqual(
      ["status-update", "message-chunk", "artifact-update", "status-update"]);
    expect(published.every((e) => e.correlationId === "corr-1")).toBe(true);
  });

  it("exits 1 and publishes failed when the task is missing", async () => {
    const published: Envelope[] = [];
    const code = await runWorker({
      fetchTask: async () => null,
      publishEvent: async (e) => { published.push(e); },
      queryStream: () => fakeStream(),
      ctx,
    });
    expect(code).toBe(1);
    expect(published.at(-1)?.kind).toBe("status-update"); // failed, final
  });

  it("publishes failed and exits 1 when the stream throws", async () => {
    async function* broken(): AsyncIterable<never> { throw new Error("api down"); }
    const published: Envelope[] = [];
    const code = await runWorker({
      fetchTask: async () => taskEnv,
      publishEvent: async (e) => { published.push(e); },
      queryStream: () => broken(),
      ctx,
    });
    expect(code).toBe(1);
    expect(published.at(-1)?.kind).toBe("status-update");
  });
});
