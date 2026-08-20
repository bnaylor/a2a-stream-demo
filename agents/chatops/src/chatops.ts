import { Envelope, makeEnvelope } from "@a2a-demo/protocol";
import { SdkMsg, TaskCtx, mapSdkMessage } from "@a2a-demo/agents-common";
import type { PodManager, WorkerPodSpec } from "./k8s.ts";
import type { ChatSession } from "./session.ts";

export type { ChatSession };

export interface ChatOpsDeps {
  session: ChatSession;
  pods: PodManager;
  watchInbox(cb: (env: Envelope) => void): Promise<() => void>;
  publishEvent(taskId: string, env: Envelope): Promise<void>;
  submitTask(env: Envelope): Promise<void>;
  replayEvents(taskId: string): Promise<Envelope[]>;
  subscribeEvents(taskId: string, cb: (env: Envelope) => void): Promise<() => void>;
  newSessionName(): string;
  newIds(): { taskId: string; contextId: string };
  ownSession: string;
}

export interface ChatOpsHandle {
  delegate(prompt: string): Promise<{ taskId: string; session: string }>;
  taskStatus(taskId: string): Promise<string>;
  listSessions(): Promise<string>;
  sweepOnce(): Promise<void>;
  stop(): Promise<void>;
}

interface Delegation {
  session: string;
  taskId: string;
  contextId: string;
  correlationId: string;
  artifact: string;
  gcDone: boolean;
  unsub?: () => void;
}

const NOTICE_ARTIFACT_CHARS = 500;
const DIGEST_TEXT_CHARS = 120;
const DIGEST_MAX_EVENTS = 30;
const TERMINAL_PHASES = ["Failed", "Succeeded"];
const FENCE_SENTINEL_RE = /<\/?untrusted_worker_output[^>]*>/gi;
/** The only states we will ever render. Anything else fails closed. */
const NOTICE_STATES = new Set(["completed", "failed", "canceled"]);
const UNKNOWN_STATE = "failed";

function textOf(payload: unknown): string {
  const parts = (payload as { parts?: { kind: string; text?: string }[] }).parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => p.text ?? "").join("");
}

function stateOf(payload: unknown): string | undefined {
  return (payload as { status?: { state?: string } }).status?.state;
}

/**
 * Drop fence sentinels, then cap. Idempotent, so it is safe to apply both when
 * caching an artifact and again when rendering it.
 */
function boundedExcerpt(text: string, cap = NOTICE_ARTIFACT_CHARS): string {
  return text.replace(FENCE_SENTINEL_RE, "").slice(0, cap);
}

/** Neutralize anything tag-shaped so worker text can't be read as structure. */
function escapeAngles(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip sentinels, cap, then escape — the full worker-text-to-model treatment. */
function safeText(text: string, cap = NOTICE_ARTIFACT_CHARS): string {
  return escapeAngles(boundedExcerpt(text, cap));
}

/**
 * Worker-reported states are rendered as our own words, so only our own
 * literals may appear. Unknown states fail CLOSED (`failed`) rather than
 * flattering a task that may never have finished.
 */
function safeState(state: string | undefined): string {
  return state && NOTICE_STATES.has(state) ? state : UNKNOWN_STATE;
}

/** Wrap worker-derived text in the fence the system prompt tells Claude about. */
function fence(attr: string, body: string): string {
  return `<untrusted_worker_output ${attr}>${body}</untrusted_worker_output>`;
}

/**
 * Worker output is untrusted input, not instructions: fence every excerpt we
 * splice into the ChatOps prompt so a worker can't steer the agent that holds
 * pod-creation powers. `main.ts`'s system prompt states the matching rule.
 *
 * Two things keep the fence intact:
 *   - the excerpt is stripped of fence sentinels and then has every angle
 *     bracket escaped, so no worker text can close the fence or smuggle in
 *     markup the model might read as structure;
 *   - `state` is rendered OUTSIDE the fence, so it is validated against a
 *     closed allowlist rather than echoed from the worker's payload.
 * `session` is our own generated name, never worker-controlled.
 */
function notice(session: string, state: string, artifact: string): string {
  return (
    `[notice] session ${session} ${safeState(state)}: ` +
    fence(`session="${session}"`, safeText(artifact))
  );
}

function isFinal(env: Envelope): boolean {
  return (
    env.kind === "status-update" &&
    (env.payload as { final?: boolean }).final === true
  );
}

export async function startChatOps(deps: ChatOpsDeps): Promise<ChatOpsHandle> {
  const from = { session: deps.ownSession, agentType: "claude-code" };
  const pendingNotices: string[] = [];
  /** session name -> delegation record (also the sweep's session->taskId map) */
  const delegations = new Map<string, Delegation>();
  /** correlationId of the chat turn currently (or most recently) served */
  let turnCorrelationId = "";
  /** serializes chat turns so two overlapping turns never interleave events */
  let queue: Promise<void> = Promise.resolve();

  function status(
    ctx: { taskId: string; contextId: string; correlationId: string },
    state: "working" | "failed" | "completed",
    final: boolean,
    reason?: string
  ): Envelope {
    return makeEnvelope({
      kind: "status-update",
      correlationId: ctx.correlationId,
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      from,
      payload: {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        final,
        status: { state, timestamp: new Date().toISOString() },
        ...(reason ? { metadata: { reason } } : {}),
      },
    });
  }

  async function gcPod(session: string): Promise<void> {
    const rec = delegations.get(session);
    if (rec?.gcDone) return;
    const pods = await deps.pods.listWorkerPods();
    const pod = pods.find((p) => p.session === session);
    if (rec) rec.gcDone = true;
    if (pod) await deps.pods.deletePod(pod.name);
  }

  /** A finished delegation keeps nothing: drop its subscription and its record. */
  function prune(session: string): void {
    const rec = delegations.get(session);
    if (!rec) return;
    rec.unsub?.();
    delegations.delete(session);
  }

  // 1. Chat turn: drain notices into the prompt, stream the answer onto the
  //    chat task's events subject.
  async function handleTurn(env: Envelope): Promise<void> {
    const taskId = env.taskId;
    const contextId = env.contextId;
    if (!taskId || !contextId) return;
    turnCorrelationId = env.correlationId;
    const ctx: TaskCtx = {
      taskId,
      contextId,
      correlationId: env.correlationId,
      from,
    };
    const userPrompt = (env.payload as { prompt?: string }).prompt ?? "";
    const notices = pendingNotices.splice(0, pendingNotices.length);
    const prompt = notices.length
      ? `${notices.join("\n")}\n\n${userPrompt}`
      : userPrompt;

    await deps.publishEvent(taskId, status(ctx, "working", false));
    try {
      let sawFinal = false;
      for await (const m of deps.session.send(prompt)) {
        for (const out of mapSdkMessage(m, ctx)) {
          await deps.publishEvent(taskId, out);
          if (isFinal(out)) sawFinal = true;
        }
      }
      if (!sawFinal) {
        await deps.publishEvent(
          taskId,
          status(ctx, "failed", true, "stream-ended-without-result")
        );
      }
    } catch (err) {
      await deps.publishEvent(taskId, status(ctx, "failed", true, String(err)));
    }
  }

  // 2. delegate_task
  async function delegate(
    prompt: string
  ): Promise<{ taskId: string; session: string }> {
    const session = deps.newSessionName();
    const { taskId, contextId } = deps.newIds();
    const correlationId = turnCorrelationId || contextId;
    const spec: WorkerPodSpec = { session, taskId, correlationId, contextId };
    const rec: Delegation = {
      session,
      taskId,
      contextId,
      correlationId,
      artifact: "",
      gcDone: false,
    };
    delegations.set(session, rec);

    await deps.pods.createWorkerPod(spec);
    await deps.submitTask(
      makeEnvelope({
        kind: "task",
        correlationId,
        taskId,
        contextId,
        from,
        payload: {
          id: taskId,
          contextId,
          prompt,
          status: { state: "submitted", timestamp: new Date().toISOString() },
        },
      })
    );

    const unsub = await deps.subscribeEvents(taskId, (ev) => {
      // The events subject is world-writable on this bus, so only the worker
      // we actually delegated to may drive this delegation's state.
      if (ev.from?.session !== session) return;
      if (ev.kind === "artifact-update") {
        rec.artifact = boundedExcerpt(textOf(ev.payload));
        return;
      }
      if (!isFinal(ev)) return;
      const state = stateOf(ev.payload) ?? "completed";
      pendingNotices.push(notice(session, state, rec.artifact));
      // Worker publishes its own agent-closed via bus.close(); we only GC.
      void gcPod(session)
        .catch(() => {
          /* pod already gone */
        })
        .then(() => prune(session));
    });
    rec.unsub = unsub;
    return { taskId, session };
  }

  // 3. task_status — the digest lands in ChatOps's context as a tool result, so
  //    it gets exactly the same treatment as a notice: every worker-derived
  //    line sanitized, states allowlisted, the whole body inside one fence.
  async function taskStatus(taskId: string): Promise<string> {
    const label = safeText(taskId, DIGEST_TEXT_CHARS);
    const events = await deps.replayEvents(taskId);
    if (events.length === 0) return `no events for ${label}`;
    const lines = events.slice(-DIGEST_MAX_EVENTS).map((ev) => {
      // ev.kind is validated against the protocol's closed kind list on parse.
      const bits: string[] = [ev.kind];
      const state = stateOf(ev.payload);
      if (state) bits.push(safeState(state));
      const text = safeText(textOf(ev.payload), DIGEST_TEXT_CHARS);
      if (text) bits.push(text);
      return bits.join(" ");
    });
    return (
      `${label} (${events.length} events)\n` +
      fence(`task="${label}"`, `\n${lines.join("\n")}\n`)
    );
  }

  // 4. list_sessions
  async function listSessions(): Promise<string> {
    const pods = await deps.pods.listWorkerPods();
    if (pods.length === 0) return "no worker sessions";
    return pods.map((p) => `${p.session} ${p.phase} (pod ${p.name})`).join("\n");
  }

  // 5. Crash sweep (spec §5)
  async function sweepOnce(): Promise<void> {
    const pods = await deps.pods.listWorkerPods();
    for (const pod of pods) {
      if (!TERMINAL_PHASES.includes(pod.phase)) continue;
      const rec = delegations.get(pod.session);
      if (rec) {
        const events = await deps.replayEvents(rec.taskId);
        if (!events.some(isFinal)) {
          await deps.publishEvent(
            rec.taskId,
            status(
              rec,
              "failed",
              true,
              `pod-${pod.phase.toLowerCase()}-without-final-event`
            )
          );
        }
        rec.gcDone = true;
      }
      await deps.pods.deletePod(pod.name);
      prune(pod.session);
    }
  }

  const unwatch = await deps.watchInbox((env) => {
    if (env.kind !== "task") return;
    queue = queue.then(() => handleTurn(env)).catch(() => {
      /* one bad turn must not kill the loop */
    });
  });

  return {
    delegate,
    taskStatus,
    listSessions,
    sweepOnce,
    stop: async () => {
      unwatch();
      for (const session of [...delegations.keys()]) prune(session);
      await queue;
    },
  };
}
