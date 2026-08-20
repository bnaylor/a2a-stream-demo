import { describe, expect, it } from "vitest";
import { Envelope } from "@a2a-demo/protocol";
import { PROGRESS_CHARS, makeProgressPublisher } from "./progress.ts";

const ctx = {
  taskId: "task-1", contextId: "ctx-1", correlationId: "corr-1",
  from: { session: "otter", agentType: "claude-code" },
};

function collect() {
  const published: Envelope[] = [];
  const report = makeProgressPublisher(async (e) => { published.push(e); }, ctx);
  return { published, report };
}

describe("makeProgressPublisher", () => {
  it("publishes a live chunk and a replayable working status per milestone", async () => {
    const { published, report } = collect();
    await report("fetched the spec");
    expect(published.map((e) => e.kind)).toEqual(["message-chunk", "status-update"]);

    const chunk = published[0].payload as { parts: { text: string }[]; role: string };
    expect(chunk.role).toBe("agent");
    expect(chunk.parts).toHaveLength(1);
    expect(chunk.parts[0].text).toBe("[progress] fetched the spec");

    const status = published[1].payload as {
      final: boolean; status: { state: string }; metadata: { progress: string };
    };
    expect(status.status.state).toBe("working");
    expect(status.final).toBe(false);
    expect(status.metadata.progress).toBe("fetched the spec");

    // Both carry the task's ctx so replay stitches them to the right task.
    expect(published.every((e) => e.taskId === "task-1")).toBe(true);
    expect(published.every((e) => e.contextId === "ctx-1")).toBe(true);
    expect(published.every((e) => e.correlationId === "corr-1")).toBe(true);
    expect(published.every((e) => e.from.session === "otter")).toBe(true);
  });

  it("caps a runaway message in both envelopes", async () => {
    const { published, report } = collect();
    await report("x".repeat(PROGRESS_CHARS + 500));
    const chunk = published[0].payload as { parts: { text: string }[] };
    const status = published[1].payload as { metadata: { progress: string } };
    expect(status.metadata.progress).toHaveLength(PROGRESS_CHARS);
    expect(chunk.parts[0].text).toBe(`[progress] ${"x".repeat(PROGRESS_CHARS)}`);
  });

  it("emits a fresh messageId per milestone", async () => {
    const { published, report } = collect();
    await report("one");
    await report("two");
    const ids = published
      .filter((e) => e.kind === "message-chunk")
      .map((e) => (e.payload as { messageId: string }).messageId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
