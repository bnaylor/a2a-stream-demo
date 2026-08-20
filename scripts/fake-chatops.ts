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
 * `pings` (default) — **what the GKE cluster actually puts on the wire.**
 * Captured 2026-08-20 from the live stream (worker `raven`, seqs 279-320):
 * every single thinking chunk is the bare marker `"[thinking] "` with no
 * content, because the API is in its redacted-thinking phase and "otherwise
 * streams only pings" (claude-agent-sdk `SDKThinkingTokensMessage` doc). The
 * reasoning prose then arrives separately as unmarked `text_delta`.
 *
 * `summarized` — the hypothetical if the agents asked for
 * `thinking: { display: 'summarized' }`: thinking deltas carry text. Keep this
 * mode; it is the only way to exercise a populated twisty locally, and it is
 * what the UI was built against. It does NOT represent any current deployment.
 */
const MODE = process.env.FAKE_MODE ?? "pings";

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

  // ChatOps is on the same model, so its thinking is the same shape as the
  // worker's — pings on the real wire, text only if `summarized` is asked for.
  if (MODE === "pings") {
    await emit(chatCtx, thinkingMsg(""));
    await emit(chatCtx, thinkingMsg(""));
  } else {
    await stream(chatCtx, thinkingMsg,
      "The user is asking for research. Per my instructions anything that sounds like a task should be delegated rather than answered here.\nI will spawn a worker.");
  }
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

  if (MODE === "pings") {
    // The captured shape. Thinking arrives as a run of content-free pings, so
    // `thinkingMsg("")` is not an edge case here — it is every single one.
    const ping = () => emit(workerCtx, thinkingMsg(""));
    const toolCall = async (name: string) => {
      await emit(workerCtx, { type: "assistant", message: { content: [{ type: "tool_use", name }] } });
      await sleep(TOKEN_MS * 6);
    };

    await ping();
    await ping();
    await toolCall("WebSearch");
    await ping();
    await ping();
    await toolCall("WebFetch");
    await progress("Fetched 2 of 4 sources");
    await ping();
    await toolCall("WebFetch");
    await ping();
    await ping();
    await toolCall("Read");
    await progress("Research complete across four sources");
    // The reasoning prose then arrives as ordinary unmarked text, one word at
    // a time — indistinguishable on the wire from the deliverable.
    await stream(workerCtx, textMsg,
      "I have enough to compile a solid, practical answer now. Parking is the constraint, not the food, so I weighted lot access over menu. Here is what I found: three places clear the bar.");
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
  if (MODE === "pings") {
    await emitSummary(thinkingMsg(""));
  } else {
    for (const token of tokenize("The user wants this condensed. Three options is the right length.")) {
      await emitSummary(thinkingMsg(token));
    }
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
