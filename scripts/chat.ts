// Usage: NATS_URL=nats://10.3.10.4:<nats-client NodePort> npx tsx scripts/chat.ts
import { connect, consumerOpts } from "nats";
import readline from "node:readline";
import {
  Envelope, ensureStream, makeEnvelope, newContextId, newCorrelationId,
  newTaskId, parseEnvelope, submitTask,
} from "@a2a-demo/protocol";

const url = process.env.NATS_URL;
if (!url) {
  console.error("NATS_URL is required, e.g. NATS_URL=nats://10.3.10.4:<nodePort> npx tsx scripts/chat.ts");
  process.exit(1);
}

const nc = await connect({ servers: url });
await ensureStream(await nc.jetstreamManager());
const from = { session: "terminal", agentType: "human" };

// One wildcard live tap on ALL task events: chatops replies print bare,
// delegate chunks print prefixed with their session name — the demo's interleaving.
const opts = consumerOpts();
opts.orderedConsumer();
opts.deliverNew();
const tap = await nc.jetstream().subscribe("a2a.tasks.*.events", opts);
(async () => {
  for await (const m of tap) {
    let env: Envelope;
    try { env = parseEnvelope(m.data); } catch { continue; }
    if (env.kind !== "message-chunk") continue;
    const text = (env.payload as { parts?: { text?: string }[] }).parts?.[0]?.text ?? "";
    if (env.from.session === "chatops") process.stdout.write(text);
    else process.stdout.write(`\n[${env.from.session}] ${text}`);
  }
})().catch(() => {});

const rl = readline.createInterface({ input: process.stdin });
console.log("chat> type a message; Ctrl-D to exit");
for await (const line of rl) {
  if (!line.trim()) continue;
  const taskId = newTaskId();
  const contextId = newContextId();
  await submitTask(nc, makeEnvelope({
    kind: "task", correlationId: newCorrelationId(), taskId,
    contextId, from, to: { session: "chatops" },
    payload: { id: taskId, contextId, prompt: line,
      status: { state: "submitted", timestamp: new Date().toISOString() } },
  }));
}
tap.unsubscribe();
await nc.close();
