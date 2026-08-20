/**
 * The UI's brain: one immutable state tree and one pure reducer over bus
 * events. Everything the panes render is derived from here, and nothing in
 * here reads the clock or the network — timestamps always arrive on the event
 * so replay and live traffic reduce identically.
 *
 * Imports reach into the protocol package's *pure* modules by path. The
 * package root (`@a2a-demo/protocol`) re-exports node-only code (`nats`,
 * `node:crypto`), which cannot be bundled for the browser.
 */
import type { Envelope, EnvelopeKind } from "@a2a-demo/protocol/src/envelope.ts";
import type { Artifact, TaskState } from "@a2a-demo/protocol/src/types.ts";

/** The session name of the long-lived ChatOps agent (agents/chatops/src/main.ts). */
export const CHATOPS_SESSION = "chatops";
/** The session name this browser publishes under; the rail's leftmost tap. */
export const WEB_SESSION = "you";
/** Worker progress notes ride the chat stream behind this marker. */
export const PROGRESS_PREFIX = "[progress] ";
/** No heartbeat for longer than this and an agent is presumed wedged. */
export const STALE_MS = 45_000;
/** The rail only ever animates a recent window of traffic. */
export const MAX_PULSES = 200;

export type AgentStatus = "live" | "stale" | "done" | "closed";

/** The browser's own link to the bus, which is not an agent lifecycle. */
export type ConnectionState = "connecting" | "up" | "down";

export interface AgentView {
  session: string;
  agentType: string;
  status: AgentStatus;
  /** ms since epoch, from the heartbeat event (not the payload's clock). */
  lastHeartbeat?: number;
  /**
   * Browser-clock time of the first `tick` that saw this agent, used as the
   * staleness baseline until a real heartbeat arrives. Seeded from the tick
   * rather than the card's `ts` on purpose: staleness is measured against the
   * browser's clock, and pod clocks drift.
   */
  firstSeen?: number;
  /** Latest `[progress] ` note, shown under the agent's tap. */
  statusLine?: string;
}

export interface TaskView {
  taskId: string;
  contextId: string;
  correlationId: string;
  /** Addressee session, when the envelope that created the task had one. */
  to?: string;
  state: TaskState;
  /** The session that published the task — its owner on the rail. */
  owner: string;
  artifacts: Artifact[];
}

export type ChatKind = "user" | "chatops" | "delegate" | "progress";

export interface ChatEntry {
  id: string;
  kind: ChatKind;
  session?: string;
  text: string;
  correlationId: string;
  /** Streaming chunks of one task merge into a single entry; this is the key. */
  taskId?: string;
}

export interface Pulse {
  /** Monotonically increasing; Task 4's animation loop uses it as a watermark. */
  id: number;
  fromSession: string;
  correlationId: string;
  kind: EnvelopeKind;
  /** ms since epoch, parsed from the envelope's own `ts`. */
  at: number;
}

export interface UiState {
  agents: Map<string, AgentView>;
  tasks: Map<string, TaskView>;
  chat: ChatEntry[];
  pulses: Pulse[];
  streamMsgCount: number;
  connection: ConnectionState;
}

export type BusEvent =
  | { type: "envelope"; env: Envelope; live: boolean }
  /** `agentType` comes off the heartbeat subject; absent only for malformed ones. */
  | { type: "heartbeat"; session: string; agentType?: string; at: number }
  | { type: "tick"; now: number }
  | { type: "connection"; state: ConnectionState };

/** Stand-in agentType for a pod we have only ever heard heartbeat from. */
export const UNKNOWN_AGENT_TYPE = "unknown";

export const initialState: UiState = {
  agents: new Map(),
  tasks: new Map(),
  chat: [],
  pulses: [],
  streamMsgCount: 0,
  connection: "connecting",
};

/**
 * Correlation ids get a stable hue so one conversational thread reads as one
 * colour everywhere — chat chips, rail pulses, replay strips. FNV-1a keeps
 * neighbouring uuids far apart in hue space.
 */
export function corrColor(corrId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < corrId.length; i++) {
    h ^= corrId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `hsl(${(h >>> 0) % 360} 70% 60%)`;
}

const TERMINAL: readonly TaskState[] = ["completed", "failed", "canceled"];

function chunkText(env: Envelope): string {
  const parts = (env.payload as { parts?: { text?: string }[] }).parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

function withAgent(
  agents: Map<string, AgentView>,
  session: string,
  patch: Partial<AgentView>,
): Map<string, AgentView> {
  const prev = agents.get(session);
  if (!prev) return agents;
  const next = new Map(agents);
  next.set(session, { ...prev, ...patch });
  return next;
}

/** Ensures the task exists, then folds in whatever this envelope knows. */
function upsertTask(
  tasks: Map<string, TaskView>,
  env: Envelope,
  patch: Partial<TaskView> = {},
): Map<string, TaskView> {
  if (!env.taskId) return tasks;
  const prev = tasks.get(env.taskId);
  const base: TaskView = prev ?? {
    taskId: env.taskId,
    contextId: env.contextId ?? "",
    correlationId: env.correlationId,
    to: env.to?.session,
    state: "submitted",
    owner: env.from.session,
    artifacts: [],
  };
  const next = new Map(tasks);
  next.set(env.taskId, { ...base, ...patch });
  return next;
}

function pushChat(state: UiState, entry: Omit<ChatEntry, "id">): ChatEntry[] {
  return [...state.chat, { id: `chat-${state.streamMsgCount + 1}`, ...entry }];
}

/** Consecutive streaming chunks of the same task and kind collapse into one bubble. */
function appendChunk(state: UiState, entry: Omit<ChatEntry, "id">): ChatEntry[] {
  const last = state.chat[state.chat.length - 1];
  const mergeable =
    last !== undefined &&
    entry.kind !== "progress" &&
    last.kind === entry.kind &&
    last.session === entry.session &&
    last.taskId !== undefined &&
    last.taskId === entry.taskId;
  if (!mergeable) return pushChat(state, entry);
  const merged = [...state.chat];
  merged[merged.length - 1] = { ...last, text: last.text + entry.text };
  return merged;
}

function reduceEnvelope(state: UiState, env: Envelope, live: boolean): UiState {
  const next: UiState = { ...state, streamMsgCount: state.streamMsgCount + 1 };

  if (live) {
    const pulse: Pulse = {
      id: next.streamMsgCount,
      fromSession: env.from.session,
      correlationId: env.correlationId,
      kind: env.kind,
      at: Date.parse(env.ts) || 0,
    };
    const pulses = [...state.pulses, pulse];
    next.pulses = pulses.length > MAX_PULSES ? pulses.slice(pulses.length - MAX_PULSES) : pulses;
  }

  const session = env.from.session;

  switch (env.kind) {
    case "agent-card": {
      const payload = env.payload as { session?: string; agentType?: string };
      const key = payload.session ?? session;
      const prev = state.agents.get(key);
      const agents = new Map(state.agents);
      agents.set(key, {
        ...prev,
        session: key,
        agentType: payload.agentType ?? env.from.agentType,
        status: "live",
      });
      next.agents = agents;
      break;
    }

    case "agent-closed": {
      const key = (env.payload as { session?: string }).session ?? session;
      const prev = state.agents.get(key);
      const agents = new Map(state.agents);
      agents.set(key, {
        session: key,
        agentType: env.from.agentType,
        ...prev,
        status: "closed",
      });
      next.agents = agents;
      break;
    }

    case "task": {
      const payload = env.payload as { prompt?: string; status?: { state?: TaskState } };
      next.tasks = upsertTask(state.tasks, env, {
        state: payload.status?.state ?? "submitted",
        to: env.to?.session,
        owner: session,
      });
      // A submission to ChatOps is what the human typed: the transcript's own
      // echo, so the chat pane never has to trust optimistic local state.
      if (env.to?.session === CHATOPS_SESSION) {
        next.chat = pushChat(state, {
          kind: "user",
          session,
          text: payload.prompt ?? "",
          correlationId: env.correlationId,
          taskId: env.taskId,
        });
      }
      break;
    }

    case "message-chunk": {
      next.tasks = upsertTask(state.tasks, env);
      const text = chunkText(env);
      if (session === CHATOPS_SESSION) {
        next.chat = appendChunk(state, {
          kind: "chatops",
          session,
          text,
          correlationId: env.correlationId,
          taskId: env.taskId,
        });
        break;
      }
      if (text.startsWith(PROGRESS_PREFIX)) {
        const note = text.slice(PROGRESS_PREFIX.length);
        next.chat = appendChunk(state, {
          kind: "progress",
          session,
          text: note,
          correlationId: env.correlationId,
          taskId: env.taskId,
        });
        next.agents = withAgent(state.agents, session, { statusLine: note });
        break;
      }
      next.chat = appendChunk(state, {
        kind: "delegate",
        session,
        text,
        correlationId: env.correlationId,
        taskId: env.taskId,
      });
      break;
    }

    case "status-update": {
      const payload = env.payload as { final?: boolean; status?: { state?: TaskState } };
      const state_ = payload.status?.state ?? "working";
      next.tasks = upsertTask(state.tasks, env, { state: state_ });
      const terminal = payload.final === true || TERMINAL.includes(state_);
      // ChatOps finalises a status-update per chat turn but outlives all of
      // them, so only per-task agents (the workers) retire on a terminal state.
      if (terminal && session !== CHATOPS_SESSION) {
        const prev = state.agents.get(session);
        if (prev && prev.status !== "closed") {
          next.agents = withAgent(state.agents, session, { status: "done" });
        }
      }
      break;
    }

    case "artifact-update": {
      const artifact = env.payload as Artifact;
      const prev = env.taskId ? state.tasks.get(env.taskId) : undefined;
      next.tasks = upsertTask(state.tasks, env, {
        artifacts: [...(prev?.artifacts ?? []), artifact],
      });
      break;
    }
  }

  return next;
}

export function reduce(state: UiState, event: BusEvent): UiState {
  switch (event.type) {
    case "envelope":
      return reduceEnvelope(state, event.env, event.live);

    case "heartbeat": {
      const prev = state.agents.get(event.session);
      // A heartbeat with no card behind it still means a live pod: the card is
      // published once and may predate this browser, or the pod may have
      // restarted mid-stream. Surface a minimal agent rather than lose it; a
      // later card fills in the details.
      if (!prev) {
        const agents = new Map(state.agents);
        agents.set(event.session, {
          session: event.session,
          agentType: event.agentType ?? UNKNOWN_AGENT_TYPE,
          status: "live",
          lastHeartbeat: event.at,
        });
        return { ...state, agents };
      }
      const status: AgentStatus = prev.status === "stale" ? "live" : prev.status;
      return { ...state, agents: withAgent(state.agents, event.session, { lastHeartbeat: event.at, status }) };
    }

    case "tick": {
      let agents: Map<string, AgentView> | undefined;
      for (const [session, agent] of state.agents) {
        if (agent.status !== "live" && agent.status !== "stale") continue;
        const since = agent.lastHeartbeat ?? agent.firstSeen;
        // Never heard from at all yet: start its clock now, so an agent whose
        // card arrived but whose heartbeats never do still ages out.
        if (since === undefined) {
          agents ??= new Map(state.agents);
          agents.set(session, { ...agent, firstSeen: event.now });
          continue;
        }
        const want: AgentStatus = event.now - since > STALE_MS ? "stale" : "live";
        if (want === agent.status) continue;
        agents ??= new Map(state.agents);
        agents.set(session, { ...agent, status: want });
      }
      return agents ? { ...state, agents } : state;
    }

    case "connection":
      return state.connection === event.state ? state : { ...state, connection: event.state };
  }
}
