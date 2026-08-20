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
/**
 * Extended-thinking deltas ride the chat stream behind this marker (see
 * `agents/common/src/mapper.ts`, which is the source of truth for the shape).
 * The mapper stamps it on EVERY delta individually, so a token stream looks
 * like `"[thinking] Let"`, `"[thinking]  me"`, `"[thinking]  think"` — the
 * marker is a per-fragment boundary, not a one-time header.
 */
export const THINKING_PREFIX = "[thinking] ";
/** The marker without its trailing space, which an empty delta will not have. */
const THINKING_MARKER = "[thinking]";
/** Every marker inside a run of concatenated fragments is a boundary. */
const THINKING_MARKER_RE = /\[thinking\] ?/g;
/** Longest line the rail's replay peek will show before it is elided. */
export const EXCERPT_MAX = 80;
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

export type ChatKind = "user" | "chatops" | "delegate" | "progress" | "thinking";

export interface ChatEntry {
  id: string;
  kind: ChatKind;
  session?: string;
  text: string;
  correlationId: string;
  /** Streaming chunks of one task merge into a single entry; this is the key. */
  taskId?: string;
  /**
   * `thinking` only: the reasoning log reassembled into whole lines. Deltas
   * arrive token-wise, so this is the accumulator, not a list of chunks.
   */
  lines?: string[];
  /** `thinking` only: the last non-empty line — what the collapsed row shows. */
  latest?: string;
}

export interface Pulse {
  /** Monotonically increasing; Task 4's animation loop uses it as a watermark. */
  id: number;
  fromSession: string;
  correlationId: string;
  kind: EnvelopeKind;
  /** ms since epoch, parsed from the envelope's own `ts`. */
  at: number;
  /** One sanitised line of what this envelope carried, for the replay peek. */
  excerpt?: string;
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
  /** The user retiring a finished worker's tap. Nothing on the bus retires it. */
  | { type: "dismiss"; session: string }
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

/**
 * One legible line out of arbitrary agent text: first line only, control
 * characters and runs of whitespace flattened, elided at `EXCERPT_MAX`. Used
 * anywhere a payload has to sit inside a fixed-width instrument readout.
 */
export function excerptOf(text: string): string {
  const line = text
    .split("\n", 1)[0]
    // Control characters would smear an SVG readout; \s+ then folds the gaps.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length === 0) return "";
  return line.length > EXCERPT_MAX ? `${line.slice(0, EXCERPT_MAX - 1)}…` : line;
}

const TERMINAL: readonly TaskState[] = ["completed", "failed", "canceled"];

function chunkText(env: Envelope): string {
  const parts = (env.payload as { parts?: { text?: string }[] }).parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/**
 * Splits a chunk into the part that belongs in the transcript and the part
 * that belongs in a thinking twisty.
 *
 * The marker is only honoured at position 0 — that is the mapper's guarantee,
 * and it means a worker whose prose happens to contain the literal
 * `[thinking]` keeps it as text instead of having its sentence swallowed.
 * Once a chunk *is* a thinking chunk, every further marker inside it is a
 * fragment boundary from concatenated deltas and is stripped, so no marked
 * text can leak into a plain entry however it was batched upstream.
 */
export function partitionThinking(text: string): { plain: string; thinking: string | null } {
  if (!text.startsWith(THINKING_MARKER)) return { plain: text, thinking: null };
  return { plain: "", thinking: text.replace(THINKING_MARKER_RE, "") };
}

/** What a pulse can say about itself on the replay strip, if anything. */
function envelopeExcerpt(env: Envelope): string | undefined {
  switch (env.kind) {
    case "message-chunk":
    case "artifact-update":
      return excerptOf(chunkText(env)) || undefined;
    case "task":
      return excerptOf((env.payload as { prompt?: string }).prompt ?? "") || undefined;
    default:
      return undefined;
  }
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

/**
 * Consecutive streaming chunks of the same task and kind collapse into one
 * bubble.
 *
 * Thinking entries are transparent to the merge: they are pinned where the
 * reasoning started and then updated in place, so a narrative that brackets a
 * burst of thinking ("Let me check " … "the results.") must still land in one
 * entry rather than being sawn in half by the twisty sitting between the two
 * halves. No other kind is skipped — a delegate cutting in genuinely ends the
 * previous speaker's turn.
 */
function appendChunk(state: UiState, entry: Omit<ChatEntry, "id">): ChatEntry[] {
  let at = state.chat.length - 1;
  while (at >= 0 && state.chat[at].kind === "thinking") at--;
  const last = at >= 0 ? state.chat[at] : undefined;
  const mergeable =
    last !== undefined &&
    entry.kind !== "progress" &&
    last.kind === entry.kind &&
    last.session === entry.session &&
    last.taskId !== undefined &&
    last.taskId === entry.taskId;
  if (!mergeable) return pushChat(state, entry);
  const merged = [...state.chat];
  merged[at] = { ...last, text: last.text + entry.text };
  return merged;
}

/**
 * A long-running agent can reason for thousands of lines, and every one of
 * them would otherwise be copied on every subsequent token. Cap the log; a
 * twisty is a live readout, not an archive.
 */
export const MAX_THINKING_LINES = 500;
/** Trim well past the cap so the re-join is amortised over the next 100 lines. */
const THINKING_KEEP = 400;
export const THINKING_TRIM_MARKER = "… (earlier thinking trimmed)";

/**
 * Folds one token-wise thinking delta into whole lines. The model streams
 * fragments, not lines, so the tail line is the open accumulator and only a
 * newline in the delta closes it.
 */
function mergeThinkingLines(lines: readonly string[], delta: string): string[] {
  const next = lines.length > 0 ? [...lines] : [""];
  const parts = delta.split("\n");
  next[next.length - 1] += parts[0];
  for (let i = 1; i < parts.length; i++) next.push(parts[i]);
  return next;
}

/** The trimmed log, or `undefined` when it is still under the cap. */
function trimThinkingLines(lines: string[]): string[] | undefined {
  if (lines.length <= MAX_THINKING_LINES) return undefined;
  // The old marker (always at index 0) falls off with the rest of the head, so
  // however many times this runs there is exactly one.
  return [THINKING_TRIM_MARKER, ...lines.slice(lines.length - (THINKING_KEEP - 1))];
}

/** The collapsed row shows the last line with something on it, never a blank. */
function latestLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0) return line;
  }
  return "";
}

/** SDK tools exposed over MCP are named `mcp__<server>__<tool>` on the wire. */
const MCP_PREFIX = "mcp__";
/**
 * Tools whose activity is plumbing, not work worth narrating.
 *
 * `report_progress` is our own MCP tool: every milestone fires it, so
 * narrating it printed "using report_progress…" immediately above the
 * `[progress] ` line that is the actual signal. `TodoWrite` is the agent's
 * internal bookkeeping — it says nothing about the task the audience is
 * watching. Read/Write/Glob/Grep are deliberately NOT here: for a research
 * task, drafting into the pod's scratch directory is real work.
 */
const SILENT_TOOLS = new Set(["report_progress", "TodoWrite"]);

/** `mcp__a2a__report_progress` → `report_progress`; the wiring is ours, not news. */
function bareToolName(tool: string): string {
  if (!tool.startsWith(MCP_PREFIX)) return tool;
  const rest = tool.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  return sep >= 0 ? rest.slice(sep + 2) : rest;
}

/**
 * The tool name the mapper hangs off a `tool_use` beat
 * (`agents/common/src/mapper.ts`: `metadata: { tool: name }` on a non-final
 * `working` status-update), reduced to the name a person would recognise, or
 * `undefined` when this tool is not worth a line. `report_progress` milestones
 * arrive separately as `metadata.progress`, so the two never collide.
 */
function toolOf(payload: unknown): string | undefined {
  const raw = (payload as { metadata?: { tool?: unknown } }).metadata?.tool;
  if (typeof raw !== "string" || raw === "") return undefined;
  const name = bareToolName(raw);
  return name === "" || SILENT_TOOLS.has(name) ? undefined : name;
}

/** How a tool beat reads in the transcript. */
function toolNote(tool: string): string {
  return `using ${tool}…`;
}

/**
 * A tool beat, unless it would repeat the line already at the bottom.
 *
 * A research worker fires the same tool many times in a row; six identical
 * "using WebSearch…" lines say nothing that one does. Consecutive *identical*
 * lines from the same session collapse, but a different tool starts a new line,
 * so the sequence of what the worker is doing still reads. Thinking entries are
 * skipped when deciding what is "consecutive", exactly as in `appendChunk` —
 * they are pinned and updated in place, not appended.
 */
function appendToolNote(state: UiState, entry: Omit<ChatEntry, "id">): ChatEntry[] {
  let at = state.chat.length - 1;
  while (at >= 0 && state.chat[at].kind === "thinking") at--;
  const last = at >= 0 ? state.chat[at] : undefined;
  const repeat =
    last !== undefined &&
    last.kind === "progress" &&
    last.session === entry.session &&
    last.text === entry.text;
  return repeat ? state.chat : pushChat(state, entry);
}

/** Index of this agent-task's twisty, or -1 before it has one. */
function thinkingIndex(chat: readonly ChatEntry[], session: string, taskId?: string): number {
  return chat.findIndex(
    (e) => e.kind === "thinking" && e.session === session && e.taskId === taskId,
  );
}

function hasThinking(state: UiState, session: string, taskId?: string): boolean {
  return thinkingIndex(state.chat, session, taskId) >= 0;
}

/**
 * One accumulating entry per (session, task), pinned at the point in the
 * transcript where that agent started thinking. Everything after that updates
 * it in place instead of interleaving a new line, which is the whole point:
 * two agents thinking at once now update two twisties, not one shuffled deck.
 */
function appendThinking(state: UiState, entry: Omit<ChatEntry, "id">, delta: string): ChatEntry[] {
  const at = thinkingIndex(state.chat, entry.session ?? "", entry.taskId);
  const prev = at >= 0 ? state.chat[at] : undefined;
  const grown = mergeThinkingLines(prev?.lines ?? [], delta);
  const trimmed = trimThinkingLines(grown);
  const lines = trimmed ?? grown;
  const patch = {
    lines,
    latest: latestLine(lines),
    // `lines.join("\n")` is exactly the delta stream concatenated, so the
    // common path just appends and only a trim pays for a re-join.
    text: trimmed ? trimmed.join("\n") : (prev?.text ?? "") + delta,
  };
  if (at < 0) return pushChat(state, { ...entry, ...patch });
  const merged = [...state.chat];
  merged[at] = { ...merged[at], ...patch };
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
      excerpt: envelopeExcerpt(env),
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
        statusLine: undefined,
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
      // Reasoning is not transcript. Everyone's thinking — ChatOps' included —
      // collects behind a twisty instead of interleaving line by line.
      const { thinking } = partitionThinking(text);
      if (thinking !== null) {
        // A thinking block whose streamed content is empty (a signature-only
        // block opens one) must not leave an empty twisty sitting in the
        // transcript with nothing to say. Swallow it: the marker was still
        // consumed, so it can never fall through to a plain entry either.
        if (thinking.trim() === "" && !hasThinking(state, session, env.taskId)) break;
        next.chat = appendThinking(
          state,
          {
            kind: "thinking",
            session,
            text: "",
            correlationId: env.correlationId,
            taskId: env.taskId,
          },
          thinking,
        );
        break;
      }
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
      // A worker reaching for a tool is the one part of a long run that
      // otherwise reached the rail and nothing else: minutes of WebFetch look
      // like a frozen transcript next to a busy bus. ChatOps is excluded — it
      // narrates its own tool use in words.
      const tool = terminal ? undefined : toolOf(env.payload);
      if (tool !== undefined && session !== CHATOPS_SESSION) {
        next.chat = appendToolNote(state, {
          kind: "progress",
          session,
          text: toolNote(tool),
          correlationId: env.correlationId,
          taskId: env.taskId,
        });
      }
      // ChatOps finalises a status-update per chat turn but outlives all of
      // them, so only per-task agents (the workers) retire on a terminal state.
      if (terminal && session !== CHATOPS_SESSION) {
        const prev = state.agents.get(session);
        if (prev && prev.status !== "closed") {
          // The last milestone goes with it: a finished tap reports the state
          // it finished in, not what it was doing several seconds ago.
          next.agents = withAgent(state.agents, session, {
            status: "done",
            statusLine: undefined,
          });
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

    // A finished worker's tap is the user's to clear. Nothing on the bus
    // retires it, and nothing on a timer does either — the tap and its replay
    // stay available until someone says otherwise.
    case "dismiss": {
      if (!state.agents.has(event.session)) return state;
      const agents = new Map(state.agents);
      agents.delete(event.session);
      return { ...state, agents };
    }

    case "connection":
      return state.connection === event.state ? state : { ...state, connection: event.state };
  }
}
