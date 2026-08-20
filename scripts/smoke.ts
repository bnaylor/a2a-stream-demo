import { connect } from "nats";
import {
  ensureStream, makeEnvelope, newContextId, newCorrelationId, newSessionName,
  newTaskId, publishEnvelope, replayTaskEvents, subscribeTaskEvents,
  taskEventsSubject, taskRequestSubject, startHeartbeat,
  Envelope, TaskStatusUpdate,
} from "@a2a-demo/protocol";

const url = process.env.NATS_URL;
if (!url) {
  console.error("NATS_URL is required, e.g. NATS_URL=nats://10.3.10.4:<nodePort> npm run smoke");
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

const nc = await connect({ servers: url });
await ensureStream(await nc.jetstreamManager());

// --- fake worker: consumes a task request, streams events, finishes ---
const session = newSessionName();
const workerFrom = { session, agentType: "fake-worker" };
async function runWorker(taskId: string, contextId: string, correlationId: string) {
  const events = taskEventsSubject(taskId);
  const status = (state: TaskStatusUpdate["status"]["state"], final: boolean) =>
    publishEnvelope(nc, events, makeEnvelope({
      kind: "status-update", correlationId, taskId, contextId, from: workerFrom,
      payload: { taskId, contextId, status: { state, timestamp: new Date().toISOString() }, final },
    }));
  await status("working", false);
  for (const word of ["thinking…", "chunk one", "chunk two"]) {
    await publishEnvelope(nc, events, makeEnvelope({
      kind: "message-chunk", correlationId, taskId, contextId, from: workerFrom,
      payload: { role: "agent", messageId: newTaskId(), parts: [{ kind: "text", text: word }] },
    }));
  }
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "artifact-update", correlationId, taskId, contextId, from: workerFrom,
    payload: { artifactId: "artifact-1", name: "result", parts: [{ kind: "text", text: "42" }] },
  }));
  await status("completed", true);
}

// --- fake delegator: submits the task, watches the live stream ---
const taskId = newTaskId();
const contextId = newContextId();
const correlationId = newCorrelationId();
const delegatorFrom = { session: "chatops-smoke", agentType: "fake-delegator" };
const stopHb = startHeartbeat(nc, {
  agentType: "fake-delegator", owner: "bnaylor", session: "chatops-smoke", instanceId: taskId,
});

const live: Envelope[] = [];
let sawFinal: (() => void) | undefined;
const done = new Promise<void>((resolve) => { sawFinal = resolve; });
const stopSub = await subscribeTaskEvents(nc, taskId, (env) => {
  live.push(env);
  console.log(`[${env.from.session}] ${env.kind}`);
  if (env.kind === "status-update" && (env.payload as TaskStatusUpdate).final) sawFinal!();
});

await publishEnvelope(nc, taskRequestSubject(taskId), makeEnvelope({
  kind: "task", correlationId, taskId, contextId, from: delegatorFrom,
  payload: { id: taskId, contextId, status: { state: "submitted", timestamp: new Date().toISOString() } },
}));
await runWorker(taskId, contextId, correlationId);

await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000))])
  .catch((e) => fail(`no terminal event within 10s: ${e}`));
stopSub();
stopHb();

// --- assertions ---
if (live.length !== 6) fail(`expected 6 live events, saw ${live.length}`);
if (live.some((e) => e.correlationId !== correlationId)) fail("correlationId not preserved across hops");

// Demo purpose #2: a cold replay reconstructs the full task history.
const replayed = await replayTaskEvents(nc, taskId);
if (replayed.length !== 6) fail(`cold replay expected 6 events, saw ${replayed.length}`);
if (replayed.map((e) => e.kind).join(",") !==
    "status-update,message-chunk,message-chunk,message-chunk,artifact-update,status-update") {
  fail(`unexpected replay order: ${replayed.map((e) => e.kind).join(",")}`);
}

console.log(`SMOKE PASS: task ${taskId} delegated to ${session}, 6 events streamed live and replayed cold.`);
await nc.close();
