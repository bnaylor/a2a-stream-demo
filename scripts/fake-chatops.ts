import { connect } from "nats";
import {
  ensureStream, makeEnvelope, newSessionName, publishEnvelope, taskEventsSubject,
  watchTaskRequests,
} from "@a2a-demo/protocol";

const url = process.env.NATS_URL;
if (!url) {
  console.error("NATS_URL is required");
  process.exit(1);
}

const nc = await connect({ servers: url });
await ensureStream(await nc.jetstreamManager());

const from = { session: "chatops", agentType: "fake-chatops" };
const workerSession = "worker-fake-lynx";

await watchTaskRequests(nc, "chatops", async (taskEnv) => {
  if (!taskEnv.taskId || !taskEnv.contextId) return;
  const { taskId, contextId, correlationId } = taskEnv;
  const events = taskEventsSubject(taskId);
  const prompt = (taskEnv.payload as { prompt?: string }).prompt ?? "";

  // working status
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "status-update", correlationId, taskId, contextId, from,
    payload: { taskId, contextId, status: { state: "working", timestamp: new Date().toISOString() }, final: false },
  }));

  // chatops reply chunk
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "message-chunk", correlationId, taskId, contextId, from,
    payload: { role: "assistant", messageId: taskId, parts: [{ kind: "text", text: `you said: ${prompt}` }] },
  }));

  // fake delegate chunks from worker
  const workerFrom = { session: workerSession, agentType: "fake-worker" };
  for (const chunk of ["[thinking…]", "[done]"]) {
    await publishEnvelope(nc, events, makeEnvelope({
      kind: "message-chunk", correlationId, taskId, contextId, from: workerFrom,
      payload: { role: "agent", messageId: taskId, parts: [{ kind: "text", text: chunk }] },
    }));
  }

  // completed status
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "status-update", correlationId, taskId, contextId, from,
    payload: { taskId, contextId, status: { state: "completed", timestamp: new Date().toISOString() }, final: true },
  }));
});
