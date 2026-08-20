/**
 * A local stand-in for the ChatOps agent and one worker pod.
 *
 * The point of this script is fidelity, not brevity: it drives the *real*
 * `mapSdkMessage` with synthetic SDK stream messages, so every envelope it
 * publishes has exactly the shape a real agent puts on the wire — in
 * particular per-token `thinking_delta`s, each of which the mapper prefixes
 * with `[thinking] ` individually. Hand-rolling the envelopes here would let
 * the UI be developed against a wire format that does not exist.
 *
 * It also mimics the worker's `report_progress` tool, which publishes each
 * milestone twice (a `[progress] ` chunk and a `working` status carrying
 * `metadata.progress`), and ChatOps' own proactive summary turn on a second
 * task id.
 */
import { connect } from "nats";
import {
  ensureStream,
  makeEnvelope,
  publishEnvelope,
  taskEventsSubject,
  watchTaskRequests,
} from "@a2a-demo/protocol";
import { mapSdkMessage, type SdkMsg, type TaskCtx } from "@a2a-demo/agents-common";

const url = process.env.NATS_URL;
if (!url) {
  console.error("NATS_URL is required");
  process.exit(1);
}

/** Slow enough to watch, fast enough to iterate on. */
const TOKEN_MS = Number(process.env.FAKE_TOKEN_MS ?? 45);
/**
 * `thinking` — a model with extended thinking on: reasoning arrives as
 * `thinking_delta`, which the mapper marks.
 * `prose` — a model without it: the same reasoning arrives as ordinary
 * `text_delta` and is indistinguishable from the deliverable on the wire, and
 * the run is mostly silent tool calls. This is the shape that produced the
 * GKE bug report.
 */
const MODE = process.env.FAKE_MODE ?? "thinking";

const nc = await connect({ servers: url });
await ensureStream(await nc.jetstreamManager());

const from = { session: "chatops", agentType: "fake-chatops" };
const workerSession = "otter";
const workerFrom = { session: workerSession, agentType: "fake-worker" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits text the way a model streams it: a few characters at a time. */
function tokenize(text: string): string[] {
  return text.match(/\s*\S+/g) ?? [];
}

const thinkingMsg = (thinking: string): SdkMsg => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
});

const textMsg = (text: string): SdkMsg => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

const resultMsg = (result: string): SdkMsg => ({
  type: "result",
  subtype: "success",
  result,
});

await watchTaskRequests(nc, "chatops", async (taskEnv) => {
  if (!taskEnv.taskId || !taskEnv.contextId) return;
  const { taskId, contextId, correlationId } = taskEnv;
  const events = taskEventsSubject(taskId);
  const prompt = (taskEnv.payload as { prompt?: string }).prompt ?? "";

  const chatCtx: TaskCtx = { taskId, contextId, correlationId, from };
  const workerCtx: TaskCtx = { taskId, contextId, correlationId, from: workerFrom };

  const emit = async (ctx: TaskCtx, m: SdkMsg) => {
    for (const env of mapSdkMessage(m, ctx)) await publishEnvelope(nc, events, env);
    await sleep(TOKEN_MS);
  };
  const stream = async (ctx: TaskCtx, make: (s: string) => SdkMsg, text: string) => {
    for (const token of tokenize(text)) await emit(ctx, make(token));
  };

  // --- ChatOps takes the turn --------------------------------------------
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "status-update", correlationId, taskId, contextId, from,
    payload: { taskId, contextId, status: { state: "working", timestamp: new Date().toISOString() }, final: false },
  }));

  await stream(chatCtx, thinkingMsg,
    "The user is asking for research. Per my instructions anything that sounds like a task should be delegated rather than answered here.\nI will spawn a worker.");
  await stream(chatCtx, textMsg, `Delegating that to **otter**. I'll summarise when it reports back.`);

  // --- the worker pod ------------------------------------------------------
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "agent-card", correlationId, from: workerFrom,
    payload: { session: workerSession, agentType: "claude-code", owner: "bnaylor", startedAt: new Date().toISOString() },
  }));
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "status-update", correlationId, taskId, contextId, from: workerFrom,
    payload: { taskId, contextId, status: { state: "working", timestamp: new Date().toISOString() }, final: false },
  }));

  /** The worker's report_progress tool: one milestone, published twice. */
  const progress = async (message: string) => {
    await publishEnvelope(nc, events, makeEnvelope({
      kind: "message-chunk", correlationId, taskId, contextId, from: workerFrom,
      payload: { role: "agent", parts: [{ kind: "text", text: `[progress] ${message}` }], messageId: `msg-${Math.random()}` },
    }));
    await publishEnvelope(nc, events, makeEnvelope({
      kind: "status-update", correlationId, taskId, contextId, from: workerFrom,
      payload: {
        taskId, contextId, final: false,
        status: { state: "working", timestamp: new Date().toISOString() },
        metadata: { progress: message },
      },
    }));
    await sleep(TOKEN_MS);
  };

  await progress(`Starting research: ${prompt.slice(0, 60)}`);

  if (MODE === "prose") {
    // One thinking block whose streamed content is empty — enough to open a
    // twisty, never enough to fill it.
    await emit(workerCtx, thinkingMsg(""));
    // Then a long silent stretch of tool calls: pulses on the bus, nothing in
    // the chat. `assistant` + tool_use maps to a bare working status-update.
    for (const toolName of ["WebSearch", "WebFetch", "WebSearch", "WebFetch", "Read", "WebFetch"]) {
      await emit(workerCtx, {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: toolName }] },
      });
      await sleep(TOKEN_MS * 6);
    }
    await progress("Fetched 2 of 4 sources");
    // Finally the reasoning prose, as ordinary unmarked text.
    await stream(workerCtx, textMsg,
      "Let me think about what the user actually wants here. Parking is the constraint, not the food. I should check a few neighbourhood guides and cross-reference weekend lot availability. The second source contradicts the first on Sunday hours, so I will prefer the one with a 2026 timestamp. Here is what I found: three places clear the bar.");
  } else {
    await stream(workerCtx, thinkingMsg,
      "Let me think about what the user actually wants here. Parking is the constraint, not the food.\nI should check a few neighbourhood guides and cross-reference weekend lot availability.");
    await progress("Fetched 2 of 4 sources");
    await stream(workerCtx, thinkingMsg,
      "The second source contradicts the first on Sunday hours. I will prefer the one with a 2026 timestamp.");
    await progress("Cross-checking hours and parking");
    await stream(workerCtx, textMsg,
      "Here is what I found: three places clear the bar. **Lady Marmalade** in Leslieville has a lot behind the building.");
  }
  await emit(workerCtx, resultMsg(
    "# Toronto brunch with parking\n\n1. Lady Marmalade — lot behind the building\n2. Aunties and Uncles — permit street parking\n3. Emma's Country Kitchen — Green P a block away"));

  await publishEnvelope(nc, events, makeEnvelope({
    kind: "agent-closed", correlationId, from: workerFrom, payload: { session: workerSession },
  }));

  // --- ChatOps' proactive summary, on its own task id ----------------------
  const summaryTaskId = `${taskId}-summary`;
  const summaryCtx: TaskCtx = { taskId: summaryTaskId, contextId, correlationId, from };
  const summaryEvents = taskEventsSubject(summaryTaskId);
  const emitSummary = async (m: SdkMsg) => {
    for (const env of mapSdkMessage(m, summaryCtx)) await publishEnvelope(nc, summaryEvents, env);
    await sleep(TOKEN_MS);
  };
  await publishEnvelope(nc, summaryEvents, makeEnvelope({
    kind: "status-update", correlationId, taskId: summaryTaskId, contextId, from,
    payload: { taskId: summaryTaskId, contextId, status: { state: "working", timestamp: new Date().toISOString() }, final: false },
  }));
  for (const token of tokenize("The user wants this condensed. Three options is the right length.")) {
    await emitSummary(thinkingMsg(token));
  }
  for (const token of tokenize("[otter] found three brunch spots with parking: Lady Marmalade, Aunties and Uncles, and Emma's Country Kitchen.")) {
    await emitSummary(textMsg(token));
  }
  await publishEnvelope(nc, summaryEvents, makeEnvelope({
    kind: "status-update", correlationId, taskId: summaryTaskId, contextId, from,
    payload: { taskId: summaryTaskId, contextId, status: { state: "completed", timestamp: new Date().toISOString() }, final: true },
  }));

  // The chat task itself finishes last.
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "status-update", correlationId, taskId, contextId, from,
    payload: { taskId, contextId, status: { state: "completed", timestamp: new Date().toISOString() }, final: true },
  }));
});

console.log("fake-chatops ready");
