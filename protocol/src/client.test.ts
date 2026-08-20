import { connect } from "nats";
import { describe, expect, it } from "vitest";
import { makeEnvelope, Envelope } from "./envelope.ts";
import { newTaskId } from "./ids.ts";
import { publishEnvelope, replayTaskEvents, subscribeTaskEvents, submitTask, fetchTaskRequest, watchTaskRequests } from "./client.ts";
import { ensureStream } from "./stream.ts";
import { taskEventsSubject } from "./subjects.ts";

const url = process.env.NATS_URL;
const from = { session: "test", agentType: "test" };

describe.skipIf(!url)("client (requires NATS_URL)", () => {
  it("publishes, replays cold, and streams live", async () => {
    const nc = await connect({ servers: url });
    try {
      await ensureStream(await nc.jetstreamManager());
      const taskId = newTaskId();
      const subject = taskEventsSubject(taskId);
      const mk = (i: number) =>
        makeEnvelope({ kind: "message-chunk", correlationId: "corr-t", taskId,
          contextId: "ctx-t", from, payload: { seq: i } });

      await publishEnvelope(nc, subject, mk(0));
      await publishEnvelope(nc, subject, mk(1));

      // Cold replay sees both, in order.
      const replayed = await replayTaskEvents(nc, taskId);
      expect(replayed.map((e) => (e.payload as { seq: number }).seq)).toEqual([0, 1]);

      // Unknown task replays empty.
      expect(await replayTaskEvents(nc, newTaskId())).toEqual([]);

      // Live subscription replays history then receives new messages.
      const seen: Envelope[] = [];
      const stop = await subscribeTaskEvents(nc, taskId, (e) => seen.push(e));
      await publishEnvelope(nc, subject, mk(2));
      await new Promise((r) => setTimeout(r, 500));
      stop();
      expect(seen.map((e) => (e.payload as { seq: number }).seq)).toEqual([0, 1, 2]);
    } finally {
      await nc.close();
    }
  }, 15_000);

  it("skips malformed envelopes and continues processing", async () => {
    const nc = await connect({ servers: url });
    try {
      await ensureStream(await nc.jetstreamManager());
      const taskId = newTaskId();
      const subject = taskEventsSubject(taskId);
      const mk = (i: number) =>
        makeEnvelope({ kind: "message-chunk", correlationId: "corr-t", taskId,
          contextId: "ctx-t", from, payload: { seq: i } });

      // Publish: valid, garbage, valid
      await publishEnvelope(nc, subject, mk(0));
      const js = await nc.jetstream();
      await js.publish(subject, new TextEncoder().encode("not valid json at all"));
      await publishEnvelope(nc, subject, mk(1));

      // Cold replay skips garbage, returns only valid envelopes
      const replayed = await replayTaskEvents(nc, taskId);
      expect(replayed.map((e) => (e.payload as { seq: number }).seq)).toEqual([0, 1]);

      // Live subscription skips garbage and continues
      const seen: Envelope[] = [];
      const stop = await subscribeTaskEvents(nc, taskId, (e) => seen.push(e));
      await publishEnvelope(nc, subject, mk(2));
      await new Promise((r) => setTimeout(r, 500));
      stop();
      expect(seen.map((e) => (e.payload as { seq: number }).seq)).toEqual([0, 1, 2]);
    } finally {
      await nc.close();
    }
  }, 15_000);

  it("submitTask + fetchTaskRequest + watchTaskRequests round-trip", async () => {
    const nc = await connect({ servers: url });
    try {
      await ensureStream(await nc.jetstreamManager());
      const taskId = newTaskId();
      const seen: Envelope[] = [];
      const stop = await watchTaskRequests(nc, "chatops", (e) => seen.push(e));

      const env = makeEnvelope({
        kind: "task", correlationId: "corr-w", taskId, contextId: "ctx-w",
        from, to: { session: "chatops" },
        payload: { id: taskId, contextId: "ctx-w", status: { state: "submitted", timestamp: new Date().toISOString() } },
      });
      await submitTask(nc, env);

      // Addressed-elsewhere and unaddressed tasks are not delivered to the callback.
      const otherId = newTaskId();
      await submitTask(nc, makeEnvelope({
        kind: "task", correlationId: "corr-w2", taskId: otherId, contextId: "ctx-w",
        from, to: { session: "someone-else" },
        payload: { id: otherId, contextId: "ctx-w", status: { state: "submitted", timestamp: new Date().toISOString() } },
      }));

      await new Promise((r) => setTimeout(r, 500));
      stop();
      expect(seen.map((e) => e.taskId)).toEqual([taskId]);

      const fetched = await fetchTaskRequest(nc, taskId);
      expect(fetched?.correlationId).toBe("corr-w");
      expect(await fetchTaskRequest(nc, newTaskId())).toBeNull();
    } finally {
      await nc.close();
    }
  }, 15_000);
});
