import { describe, expect, it } from "vitest";
import { makeEnvelope, type Envelope } from "@a2a-demo/protocol/src/envelope.ts";
import {
  MAX_THINKING_LINES,
  THINKING_TRIM_MARKER,
  type BusEvent,
  type UiState,
  corrColor,
  excerptOf,
  initialState,
  partitionThinking,
  reduce,
} from "./model.ts";

const CORR = "corr-1";
const CTX = "ctx-1";
const TASK = "task-1";

function card(session: string, agentType = "claude-code"): Envelope {
  return makeEnvelope({
    kind: "agent-card",
    correlationId: CORR,
    from: { session, agentType },
    payload: { session, agentType, owner: "bnaylor", startedAt: "2026-08-20T00:00:00.000Z" },
  });
}

function closed(session: string, agentType = "claude-code"): Envelope {
  return makeEnvelope({
    kind: "agent-closed",
    correlationId: CORR,
    from: { session, agentType },
    payload: { session },
  });
}

function chunk(session: string, text: string, taskId = TASK, corr = CORR): Envelope {
  return makeEnvelope({
    kind: "message-chunk",
    correlationId: corr,
    taskId,
    contextId: CTX,
    from: { session, agentType: "claude-code" },
    payload: { role: "agent", parts: [{ kind: "text", text }], messageId: "msg-1" },
  });
}

function status(
  session: string,
  state: "working" | "completed" | "failed" | "canceled",
  final: boolean,
  taskId = TASK,
  corr = CORR,
): Envelope {
  return makeEnvelope({
    kind: "status-update",
    correlationId: corr,
    taskId,
    contextId: CTX,
    from: { session, agentType: "claude-code" },
    payload: {
      taskId,
      contextId: CTX,
      final,
      status: { state, timestamp: "2026-08-20T00:00:01.000Z" },
    },
  });
}

function artifact(session: string, text: string, taskId = TASK): Envelope {
  return makeEnvelope({
    kind: "artifact-update",
    correlationId: CORR,
    taskId,
    contextId: CTX,
    from: { session, agentType: "claude-code" },
    payload: { artifactId: `artifact-${taskId}`, parts: [{ kind: "text", text }] },
  });
}

function submission(
  text: string,
  to = "chatops",
  taskId = TASK,
  corr = CORR,
  from = "you",
): Envelope {
  return makeEnvelope({
    kind: "task",
    correlationId: corr,
    taskId,
    contextId: CTX,
    from: { session: from, agentType: "human" },
    to: { session: to },
    payload: {
      id: taskId,
      contextId: CTX,
      prompt: text,
      status: { state: "submitted", timestamp: "2026-08-20T00:00:00.000Z" },
    },
  });
}

const ev = (env: Envelope, live = true): BusEvent => ({ type: "envelope", env, live });

function apply(state: UiState, ...events: BusEvent[]): UiState {
  return events.reduce(reduce, state);
}

describe("reduce: agent lifecycle", () => {
  it("adds an agent on agent-card", () => {
    const s = apply(initialState, ev(card("otter")));
    expect(s.agents.get("otter")).toMatchObject({
      session: "otter",
      agentType: "claude-code",
      status: "live",
    });
  });

  it("refreshes an existing agent on a repeated agent-card, keeping heartbeat", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      { type: "heartbeat", session: "otter", at: 1_000 },
      ev(card("otter")),
    );
    expect(s.agents.get("otter")).toMatchObject({ status: "live", lastHeartbeat: 1_000 });
    expect(s.agents.size).toBe(1);
  });

  it("marks the agent closed on agent-closed", () => {
    const s = apply(initialState, ev(card("otter")), ev(closed("otter")));
    expect(s.agents.get("otter")?.status).toBe("closed");
  });

  it("records the heartbeat timestamp", () => {
    const s = apply(initialState, ev(card("otter")), {
      type: "heartbeat",
      session: "otter",
      at: 5_000,
    });
    expect(s.agents.get("otter")?.lastHeartbeat).toBe(5_000);
  });

  // A heartbeat can beat its own card onto the stream (the card is published
  // once, the heartbeat every few seconds), and a worker that restarts after
  // the browser connected may never re-publish one. The pod is alive and
  // shouting either way, so the rail shows it.
  it("creates a minimal live agent for a heartbeat with no card yet", () => {
    const s = apply(initialState, {
      type: "heartbeat",
      session: "ghost",
      agentType: "claude-code",
      at: 5_000,
    });
    expect(s.agents.get("ghost")).toEqual({
      session: "ghost",
      agentType: "claude-code",
      status: "live",
      lastHeartbeat: 5_000,
    });
  });

  it("falls back to an unknown agentType when the heartbeat carries none", () => {
    const s = apply(initialState, { type: "heartbeat", session: "ghost", at: 5_000 });
    expect(s.agents.get("ghost")).toMatchObject({ agentType: "unknown", status: "live" });
  });

  it("upgrades a heartbeat-only agent when its card finally lands", () => {
    const s = apply(
      initialState,
      { type: "heartbeat", session: "otter", agentType: "unknown", at: 5_000 },
      ev(card("otter", "claude-code")),
    );
    expect(s.agents.size).toBe(1);
    expect(s.agents.get("otter")).toMatchObject({
      agentType: "claude-code",
      status: "live",
      lastHeartbeat: 5_000,
    });
  });

  it("does not revive a closed agent on a late heartbeat", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(closed("otter")),
      { type: "heartbeat", session: "otter", at: 9_000 },
    );
    expect(s.agents.get("otter")?.status).toBe("closed");
  });
});

describe("reduce: connection", () => {
  it("starts out connecting", () => {
    expect(initialState.connection).toBe("connecting");
  });

  it("records the connection state", () => {
    const s = reduce(initialState, { type: "connection", state: "up" });
    expect(s.connection).toBe("up");
    expect(reduce(s, { type: "connection", state: "down" }).connection).toBe("down");
  });

  it("is a no-op when the state has not changed", () => {
    const up = reduce(initialState, { type: "connection", state: "up" });
    expect(reduce(up, { type: "connection", state: "up" })).toBe(up);
  });

  it("does not count as stream traffic", () => {
    const s = reduce(initialState, { type: "connection", state: "up" });
    expect(s.streamMsgCount).toBe(0);
    expect(s.pulses).toHaveLength(0);
  });

  it("leaves the agents it already knows about alone", () => {
    const seeded = apply(initialState, ev(card("otter")));
    const s = reduce(seeded, { type: "connection", state: "down" });
    expect(s.agents.get("otter")?.status).toBe("live");
  });
});

describe("reduce: staleness", () => {
  const seeded = apply(initialState, ev(card("otter")), {
    type: "heartbeat",
    session: "otter",
    at: 100_000,
  });

  it("stays live at 44 s since the last heartbeat", () => {
    const s = reduce(seeded, { type: "tick", now: 100_000 + 44_000 });
    expect(s.agents.get("otter")?.status).toBe("live");
  });

  it("stays live at exactly 45 s (stale is strictly past 45 s)", () => {
    const s = reduce(seeded, { type: "tick", now: 100_000 + 45_000 });
    expect(s.agents.get("otter")?.status).toBe("live");
  });

  it("goes stale past 45 s", () => {
    const s = reduce(seeded, { type: "tick", now: 100_000 + 45_001 });
    expect(s.agents.get("otter")?.status).toBe("stale");
  });

  it("returns to live when a fresh heartbeat arrives", () => {
    const stale = reduce(seeded, { type: "tick", now: 200_000 });
    expect(stale.agents.get("otter")?.status).toBe("stale");
    const revived = reduce(stale, { type: "heartbeat", session: "otter", at: 200_100 });
    expect(revived.agents.get("otter")?.status).toBe("live");
  });

  // A card with no heartbeat behind it is the signature of a pod that died
  // before it ever beat, or of a heartbeat subscription that isn't landing.
  // Either way it must not sit on the rail claiming to be live forever.
  describe("agents that have never heartbeat", () => {
    const carded = apply(initialState, ev(card("otter")));

    it("starts the staleness clock on the first tick", () => {
      const s = reduce(carded, { type: "tick", now: 100_000 });
      expect(s.agents.get("otter")).toMatchObject({ status: "live", firstSeen: 100_000 });
    });

    it("stays live at 44 s after that first tick", () => {
      const started = reduce(carded, { type: "tick", now: 100_000 });
      const s = reduce(started, { type: "tick", now: 144_000 });
      expect(s.agents.get("otter")?.status).toBe("live");
    });

    it("goes stale past 45 s with no heartbeat at all", () => {
      const started = reduce(carded, { type: "tick", now: 100_000 });
      const s = reduce(started, { type: "tick", now: 145_001 });
      expect(s.agents.get("otter")?.status).toBe("stale");
    });

    it("prefers a real heartbeat over the first-seen fallback", () => {
      const started = reduce(carded, { type: "tick", now: 100_000 });
      const beat = reduce(started, { type: "heartbeat", session: "otter", at: 140_000 });
      expect(reduce(beat, { type: "tick", now: 145_001 }).agents.get("otter")?.status).toBe("live");
    });
  });

  it("does not resurrect closed or done agents on tick", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      { type: "heartbeat", session: "otter", at: 100_000 },
      ev(closed("otter")),
    );
    expect(reduce(s, { type: "tick", now: 100_100 }).agents.get("otter")?.status).toBe("closed");
  });
});

describe("reduce: chat entries", () => {
  it("appends a chatops entry for a chatops message-chunk", () => {
    const s = apply(initialState, ev(chunk("chatops", "hello")));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({
      kind: "chatops",
      text: "hello",
      correlationId: CORR,
      session: "chatops",
    });
  });

  it("merges consecutive chatops chunks of the same task into one entry", () => {
    const s = apply(
      initialState,
      ev(chunk("chatops", "hel")),
      ev(chunk("chatops", "lo ")),
      ev(chunk("chatops", "world")),
    );
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0].text).toBe("hello world");
  });

  it("does not merge chatops chunks from different tasks", () => {
    const s = apply(
      initialState,
      ev(chunk("chatops", "a", "task-1")),
      ev(chunk("chatops", "b", "task-2")),
    );
    expect(s.chat.map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("appends a delegate entry for a worker message-chunk", () => {
    const s = apply(initialState, ev(card("otter")), ev(chunk("otter", "digging")));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({ kind: "delegate", session: "otter", text: "digging" });
  });

  it("does not merge a delegate chunk into a preceding chatops entry", () => {
    const s = apply(initialState, ev(chunk("chatops", "a")), ev(chunk("otter", "b")));
    expect(s.chat.map((c) => c.kind)).toEqual(["chatops", "delegate"]);
  });

  it("turns a [progress] chunk into a progress entry and sets the agent statusLine", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(chunk("otter", "[progress] fetching spec 2/2")),
    );
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({
      kind: "progress",
      session: "otter",
      text: "fetching spec 2/2",
    });
    expect(s.agents.get("otter")?.statusLine).toBe("fetching spec 2/2");
  });

  it("sets the statusLine on a heartbeat-only agent that has no card yet", () => {
    const s = apply(
      initialState,
      { type: "heartbeat", session: "otter", agentType: "claude-code", at: 1_000 },
      ev(chunk("otter", "[progress] fetching spec 2/2")),
    );
    expect(s.agents.get("otter")?.statusLine).toBe("fetching spec 2/2");
  });

  it("still drops the statusLine when nothing has announced the agent", () => {
    const s = apply(initialState, ev(chunk("otter", "[progress] fetching spec 2/2")));
    expect(s.agents.size).toBe(0);
    expect(s.chat[0]).toMatchObject({ kind: "progress", text: "fetching spec 2/2" });
  });

  it("keeps consecutive progress notes as separate entries", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(chunk("otter", "[progress] one")),
      ev(chunk("otter", "[progress] two")),
    );
    expect(s.chat.map((c) => c.text)).toEqual(["one", "two"]);
    expect(s.agents.get("otter")?.statusLine).toBe("two");
  });

  it("adds a user entry for a task submission addressed to chatops", () => {
    const s = apply(initialState, ev(submission("what is otter doing?")));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({
      kind: "user",
      text: "what is otter doing?",
      correlationId: CORR,
      session: "you",
    });
  });

  it("does not add a user entry for a task addressed elsewhere", () => {
    const s = apply(initialState, ev(submission("go dig", "otter")));
    expect(s.chat).toHaveLength(0);
    expect(s.tasks.get(TASK)).toMatchObject({ to: "otter", state: "submitted" });
  });

  it("gives every chat entry a unique id", () => {
    const s = apply(
      initialState,
      ev(submission("hi")),
      ev(chunk("chatops", "a", "task-2")),
      ev(chunk("otter", "b", "task-3")),
    );
    expect(new Set(s.chat.map((c) => c.id)).size).toBe(3);
  });
});

// Extended thinking is a firehose of token-wise deltas, each one carrying the
// `[thinking] ` marker. Interleaved into the transcript it shredded everyone
// else's output; it now collects into one entry per agent-task.
describe("reduce: thinking", () => {
  const think = (session: string, text: string, taskId = TASK, corr = CORR) =>
    ev(chunk(session, `[thinking] ${text}`, taskId, corr));

  it("routes a thinking chunk into a thinking entry, not a delegate line", () => {
    const s = apply(initialState, ev(card("otter")), think("otter", "Let me start"));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({
      kind: "thinking",
      session: "otter",
      taskId: TASK,
      correlationId: CORR,
      latest: "Let me start",
    });
    expect(s.chat[0].lines).toEqual(["Let me start"]);
  });

  it("merges token-wise deltas into one coherent line", () => {
    const s = apply(
      initialState,
      think("otter", "Let me "),
      think("otter", "think about "),
      think("otter", "NATS."),
    );
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0].lines).toEqual(["Let me think about NATS."]);
    expect(s.chat[0].latest).toBe("Let me think about NATS.");
  });

  it("splits on newlines inside a delta, however they arrive", () => {
    const s = apply(
      initialState,
      think("otter", "first line"),
      think("otter", "\nsecond "),
      think("otter", "line\nthird line"),
    );
    expect(s.chat[0].lines).toEqual(["first line", "second line", "third line"]);
    expect(s.chat[0].latest).toBe("third line");
  });

  it("keeps the latest line non-empty across a trailing newline", () => {
    const s = apply(initialState, think("otter", "a thought"), think("otter", "\n"));
    expect(s.chat[0].latest).toBe("a thought");
  });

  it("keeps a separate entry per session and per task", () => {
    const s = apply(
      initialState,
      think("otter", "otter thought", "t1"),
      think("lynx", "lynx thought", "t2"),
      think("otter", " continues", "t1"),
      think("otter", "another task", "t3"),
    );
    expect(s.chat).toHaveLength(3);
    expect(s.chat.map((c) => c.latest)).toEqual([
      "otter thought continues",
      "lynx thought",
      "another task",
    ]);
  });

  it("pins the entry where the reasoning first appeared, however late the deltas are", () => {
    const s = apply(
      initialState,
      think("otter", "start", "t1"),
      ev(chunk("lynx", "unrelated output", "t2")),
      think("otter", " and end", "t1"),
    );
    expect(s.chat.map((c) => c.kind)).toEqual(["thinking", "delegate"]);
    expect(s.chat[0].latest).toBe("start and end");
  });

  it("gives chatops' own thinking the same treatment", () => {
    const s = apply(initialState, ev(chunk("chatops", "[thinking] weighing options")));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({ kind: "thinking", session: "chatops" });
  });

  // The bug this whole change exists to kill: thinking used to land as its own
  // transcript line in the middle of ChatOps' sentence.
  it("no longer splits chatops narrative around its own thinking", () => {
    const s = apply(
      initialState,
      ev(chunk("chatops", "Spinning up a worker ")),
      ev(chunk("chatops", "[thinking] which pool should ")),
      ev(chunk("chatops", "[thinking] this go to — the research one")),
      ev(chunk("chatops", "for that research.")),
    );
    expect(s.chat.map((c) => c.kind)).toEqual(["chatops", "thinking"]);
    expect(s.chat[0].text).toBe("Spinning up a worker for that research.");
    expect(s.chat[1].latest).toBe("which pool should this go to — the research one");
  });

  it("still ends a speaker's turn when another agent genuinely cuts in", () => {
    const s = apply(
      initialState,
      ev(chunk("chatops", "one ", "t1")),
      ev(chunk("otter", "interruption", "t2")),
      ev(chunk("chatops", "two", "t1")),
    );
    expect(s.chat.map((c) => c.kind)).toEqual(["chatops", "delegate", "chatops"]);
  });

  it("leaves [progress] milestones as their own transcript lines", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      think("otter", "hmm"),
      ev(chunk("otter", "[progress] fetching spec 2/2")),
    );
    expect(s.chat.map((c) => c.kind)).toEqual(["thinking", "progress"]);
    expect(s.agents.get("otter")?.statusLine).toBe("fetching spec 2/2");
  });

  // A worker can reason for thousands of lines, and every one of them would
  // otherwise be copied on every subsequent token.
  describe("the line cap", () => {
    const grow = (n: number) => {
      let s: UiState = initialState;
      for (let i = 0; i < n; i++) s = reduce(s, think("otter", `line ${i}\n`));
      return s;
    };

    it("keeps the log under the cap", () => {
      const s = grow(MAX_THINKING_LINES + 200);
      expect(s.chat[0].lines!.length).toBeLessThanOrEqual(MAX_THINKING_LINES);
    });

    it("drops the oldest lines and keeps the newest", () => {
      const s = grow(MAX_THINKING_LINES + 200);
      const lines = s.chat[0].lines!;
      expect(lines).not.toContain("line 0");
      expect(lines).toContain(`line ${MAX_THINKING_LINES + 199}`);
      expect(s.chat[0].latest).toBe(`line ${MAX_THINKING_LINES + 199}`);
    });

    it("marks the trim exactly once, however many times it runs", () => {
      const s = grow(MAX_THINKING_LINES * 4);
      const lines = s.chat[0].lines!;
      expect(lines.filter((l) => l === THINKING_TRIM_MARKER)).toHaveLength(1);
      expect(lines[0]).toBe(THINKING_TRIM_MARKER);
    });

    it("keeps text and lines in step across a trim", () => {
      const s = grow(MAX_THINKING_LINES + 50);
      expect(s.chat[0].text).toBe(s.chat[0].lines!.join("\n"));
    });

    it("does not trim a log that is under the cap", () => {
      const s = grow(10);
      expect(s.chat[0].lines).toHaveLength(11); // 10 lines plus the open one
      expect(s.chat[0].lines).not.toContain(THINKING_TRIM_MARKER);
      expect(s.chat[0].text).toBe(s.chat[0].lines!.join("\n"));
    });
  });

  it("leaves ordinary delegate output untouched", () => {
    const s = apply(initialState, ev(chunk("otter", "here is the answer")));
    expect(s.chat[0]).toMatchObject({ kind: "delegate", text: "here is the answer" });
    expect(s.chat[0].lines).toBeUndefined();
  });
});

/**
 * These pin the reducer to the shapes `agents/common/src/mapper.ts` actually
 * puts on the wire — that file is the source of truth and is deliberately NOT
 * imported here (the web bundle must not reach into the agents workspace), so
 * the shapes are replicated as literals. If the mapper's marker or its
 * per-delta framing changes, these are the tests that should fail.
 *
 * The shape that matters: `mapSdkMessage` emits ONE `message-chunk` per
 * `thinking_delta`, each with `parts: [{ kind: "text", text: "[thinking] " +
 * fragment }]`. The marker is stamped on every fragment, not once per block.
 */
describe("reduce: real mapper delta shapes", () => {
  /** Exactly what the mapper produces for one thinking_delta. */
  const mapperThinking = (session: string, fragment: string, taskId = TASK) =>
    ev(chunk(session, `[thinking] ${fragment}`, taskId));
  /** Exactly what the mapper produces for one text_delta. */
  const mapperText = (session: string, fragment: string, taskId = TASK) =>
    ev(chunk(session, fragment, taskId));

  it("accumulates a per-fragment-prefixed token stream into one twisty", () => {
    // "Let", " me", " think" — the marker repeats on every fragment.
    const s = apply(
      initialState,
      mapperThinking("otter", "Let"),
      mapperThinking("otter", " me"),
      mapperThinking("otter", " think"),
    );
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0].kind).toBe("thinking");
    expect(s.chat[0].latest).toBe("Let me think");
    // The marker itself never survives into the accumulated text.
    expect(s.chat[0].text).not.toContain("[thinking]");
  });

  it("keeps the twisty updating live, entry by entry", () => {
    let s = reduce(initialState, mapperThinking("otter", "Reading"));
    expect(s.chat[0].latest).toBe("Reading");
    s = reduce(s, mapperThinking("otter", " the spec"));
    expect(s.chat[0].latest).toBe("Reading the spec");
    expect(s.chat).toHaveLength(1);
  });

  // A signature-only thinking block streams no text. It used to open a twisty
  // that then sat in the transcript with nothing in it for the whole run.
  it("does not open a twisty for a thinking block with no content", () => {
    const s = apply(initialState, ev(chunk("otter", "[thinking] ")));
    expect(s.chat).toHaveLength(0);
  });

  it("still swallows the empty marker rather than showing it as output", () => {
    const s = apply(initialState, ev(chunk("otter", "[thinking]")));
    expect(s.chat).toHaveLength(0);
  });

  it("opens the twisty as soon as content does arrive", () => {
    const s = apply(
      initialState,
      ev(chunk("otter", "[thinking] ")),
      mapperThinking("otter", "now I have something"),
    );
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({ kind: "thinking", latest: "now I have something" });
  });

  it("routes fragments batched into one chunk entirely into the twisty", () => {
    // Anything that concatenates mapper fragments yields embedded markers;
    // none of them may leak into a plain entry.
    const s = apply(initialState, ev(chunk("otter", "[thinking] Let[thinking]  me[thinking]  go")));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0].kind).toBe("thinking");
    expect(s.chat[0].latest).toBe("Let me go");
  });

  it("leaves the literal word in ordinary prose alone", () => {
    // The marker is only a marker at position 0 — a worker writing about the
    // demo must not have its sentence eaten.
    const s = apply(initialState, mapperText("otter", "the UI shows a [thinking] twisty"));
    expect(s.chat[0]).toMatchObject({ kind: "delegate", text: "the UI shows a [thinking] twisty" });
  });

  it("never lets thinking text reach the rail's status line", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      mapperThinking("otter", "I should check the parking situation first"),
    );
    expect(s.agents.get("otter")?.statusLine).toBeUndefined();
  });

  // Documents a wire-level limit rather than a defect: a model without
  // extended thinking emits its reasoning as text_delta, which the mapper does
  // not mark, so the reducer cannot tell it from the deliverable.
  it("treats unmarked text_delta prose as delegate output", () => {
    const s = apply(initialState, mapperText("otter", "Let me think about what the user wants."));
    expect(s.chat[0].kind).toBe("delegate");
  });
});

describe("reduce: the rail status line", () => {
  it("tracks the latest progress milestone while the worker runs", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(chunk("otter", "[progress] one")),
      ev(chunk("otter", "[progress] two")),
    );
    expect(s.agents.get("otter")?.statusLine).toBe("two");
  });

  // A finished pod reporting "Fetched 2 of 4 sources" looks busy forever.
  it("clears on a terminal status-update", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(chunk("otter", "[progress] fetching sources")),
      ev(status("otter", "completed", true)),
    );
    expect(s.agents.get("otter")).toMatchObject({ status: "done" });
    expect(s.agents.get("otter")?.statusLine).toBeUndefined();
  });

  it("clears on agent-closed", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(chunk("otter", "[progress] fetching sources")),
      ev(closed("otter")),
    );
    expect(s.agents.get("otter")).toMatchObject({ status: "closed" });
    expect(s.agents.get("otter")?.statusLine).toBeUndefined();
  });

  it("leaves the long-lived chatops agent's line alone on its own terminal turns", () => {
    const s = apply(
      initialState,
      ev(card("chatops")),
      ev(status("chatops", "completed", true)),
    );
    expect(s.agents.get("chatops")?.status).toBe("live");
  });
});

describe("partitionThinking", () => {
  it("splits a marked chunk into no plain text and the fragment", () => {
    expect(partitionThinking("[thinking] hello")).toEqual({ plain: "", thinking: "hello" });
  });

  it("strips every embedded marker from a batched run", () => {
    expect(partitionThinking("[thinking] a[thinking] b").thinking).toBe("ab");
  });

  it("reports unmarked text as plain", () => {
    expect(partitionThinking("just output")).toEqual({ plain: "just output", thinking: null });
  });

  it("only honours the marker at position 0", () => {
    expect(partitionThinking("see the [thinking] marker").thinking).toBeNull();
  });

  it("handles the marker with no trailing space or content", () => {
    expect(partitionThinking("[thinking]")).toEqual({ plain: "", thinking: "" });
  });
});

// ChatOps publishes a chat task of its own when a delegation finishes, so the
// user gets the result without asking. Nobody submitted it, so there is no
// `user` entry in front of it — it must still read as an ordinary reply.
describe("reduce: proactive chatops summaries", () => {
  const SUMMARY_TASK = "task-summary";
  const DELEGATE_CORR = "corr-delegate";

  it("renders a self-initiated chatops task as a normal chatops entry", () => {
    const s = apply(
      initialState,
      ev(chunk("chatops", "[otter] found ", SUMMARY_TASK, DELEGATE_CORR)),
      ev(chunk("chatops", "three sources.", SUMMARY_TASK, DELEGATE_CORR)),
      ev(status("chatops", "completed", true, SUMMARY_TASK, DELEGATE_CORR)),
    );
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toMatchObject({
      kind: "chatops",
      session: "chatops",
      text: "[otter] found three sources.",
      taskId: SUMMARY_TASK,
    });
  });

  it("carries the delegate's correlation id, so the chip matches the thread", () => {
    const s = apply(
      initialState,
      ev(submission("research NATS", "otter", "task-deleg", DELEGATE_CORR)),
      ev(chunk("otter", "on it", "task-deleg", DELEGATE_CORR)),
      ev(chunk("chatops", "[otter] done.", SUMMARY_TASK, DELEGATE_CORR)),
    );
    expect(s.chat.map((c) => c.correlationId)).toEqual([DELEGATE_CORR, DELEGATE_CORR]);
  });

  it("keeps the summary out of the preceding turn's bubble", () => {
    const s = apply(
      initialState,
      ev(chunk("chatops", "Delegated to otter.", TASK, CORR)),
      ev(chunk("chatops", "[otter] done.", SUMMARY_TASK, DELEGATE_CORR)),
    );
    expect(s.chat.map((c) => c.text)).toEqual(["Delegated to otter.", "[otter] done."]);
  });

  it("does not retire the chatops agent when its own summary task completes", () => {
    const s = apply(
      initialState,
      ev(card("chatops")),
      ev(status("chatops", "completed", true, SUMMARY_TASK, DELEGATE_CORR)),
    );
    expect(s.agents.get("chatops")?.status).toBe("live");
  });
});

describe("reduce: dismiss", () => {
  it("removes the agent from the view", () => {
    const s = apply(initialState, ev(card("otter")), ev(status("otter", "completed", true)));
    expect(s.agents.get("otter")?.status).toBe("done");
    const after = reduce(s, { type: "dismiss", session: "otter" });
    expect(after.agents.has("otter")).toBe(false);
  });

  it("leaves the other agents alone", () => {
    const s = apply(initialState, ev(card("otter")), ev(card("lynx")));
    const after = reduce(s, { type: "dismiss", session: "otter" });
    expect([...after.agents.keys()]).toEqual(["lynx"]);
  });

  it("is a no-op for a session nobody knows about", () => {
    const s = apply(initialState, ev(card("otter")));
    expect(reduce(s, { type: "dismiss", session: "nobody" })).toBe(s);
  });

  it("does not count as stream traffic and leaves the transcript intact", () => {
    const s = apply(initialState, ev(card("otter")), ev(chunk("otter", "hi")));
    const after = reduce(s, { type: "dismiss", session: "otter" });
    expect(after.streamMsgCount).toBe(s.streamMsgCount);
    expect(after.chat).toBe(s.chat);
  });

  // Nothing on the bus retires a tap any more: a closed pod stays greyed out
  // until the user clears it, which is what keeps its replay available.
  it("is the only thing that removes a closed agent", () => {
    const s = apply(initialState, ev(card("otter")), ev(closed("otter")));
    expect(reduce(s, { type: "tick", now: 10_000_000 }).agents.has("otter")).toBe(true);
    expect(reduce(s, { type: "dismiss", session: "otter" }).agents.has("otter")).toBe(false);
  });
});

describe("excerptOf", () => {
  it("takes the first line only", () => {
    expect(excerptOf("first line\nsecond line")).toBe("first line");
  });

  it("collapses whitespace and trims", () => {
    expect(excerptOf("  a   b\tc  ")).toBe("a b c");
  });

  it("strips control characters", () => {
    expect(excerptOf("a\u0007b\u001fc")).toBe("a b c");
  });

  it("elides past 80 characters", () => {
    const out = excerptOf("x".repeat(200));
    expect(out).toHaveLength(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns the empty string for blank text", () => {
    expect(excerptOf("   \n  ")).toBe("");
  });

  it("keeps hyphens and punctuation intact", () => {
    expect(excerptOf("well-known: a/b (c)")).toBe("well-known: a/b (c)");
  });
});

describe("reduce: pulse excerpts", () => {
  it("records the first line of a message-chunk on its pulse", () => {
    const s = apply(initialState, ev(chunk("otter", "reading the spec\nthen more")));
    expect(s.pulses[0].excerpt).toBe("reading the spec");
  });

  it("records the prompt of a task", () => {
    const s = apply(initialState, ev(submission("what is otter doing?")));
    expect(s.pulses[0].excerpt).toBe("what is otter doing?");
  });

  it("records artifact text", () => {
    const s = apply(initialState, ev(artifact("otter", "the answer")));
    expect(s.pulses[0].excerpt).toBe("the answer");
  });

  it("leaves the excerpt off envelopes that carry no text", () => {
    const s = apply(initialState, ev(card("otter")), ev(status("otter", "working", false)));
    expect(s.pulses.every((p) => p.excerpt === undefined)).toBe(true);
  });
});

describe("reduce: tasks", () => {
  it("records a task on submission with owner and addressee", () => {
    const s = apply(initialState, ev(submission("hi")));
    expect(s.tasks.get(TASK)).toMatchObject({
      taskId: TASK,
      contextId: CTX,
      correlationId: CORR,
      to: "chatops",
      owner: "you",
      state: "submitted",
    });
  });

  it("advances task state on a non-terminal status-update without marking the agent done", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(submission("hi", "otter")),
      ev(status("otter", "working", false)),
    );
    expect(s.tasks.get(TASK)?.state).toBe("working");
    expect(s.agents.get("otter")?.status).toBe("live");
  });

  it("marks the task terminal and the worker done on a final status-update", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(status("otter", "completed", true)),
    );
    expect(s.tasks.get(TASK)?.state).toBe("completed");
    expect(s.agents.get("otter")?.status).toBe("done");
  });

  it("treats a terminal state as terminal even when final is not set", () => {
    const s = apply(initialState, ev(card("otter")), ev(status("otter", "failed", false)));
    expect(s.tasks.get(TASK)?.state).toBe("failed");
    expect(s.agents.get("otter")?.status).toBe("done");
  });

  it("never marks the long-lived chatops agent done", () => {
    const s = apply(
      initialState,
      ev(card("chatops")),
      ev(status("chatops", "completed", true)),
    );
    expect(s.tasks.get(TASK)?.state).toBe("completed");
    expect(s.agents.get("chatops")?.status).toBe("live");
  });

  it("records artifacts on the task", () => {
    const s = apply(initialState, ev(artifact("otter", "the answer")));
    const t = s.tasks.get(TASK);
    expect(t?.artifacts).toHaveLength(1);
    expect(t?.artifacts[0]).toMatchObject({
      artifactId: `artifact-${TASK}`,
      parts: [{ kind: "text", text: "the answer" }],
    });
  });
});

describe("reduce: pulses and counters", () => {
  it("pushes a pulse for a live envelope", () => {
    const s = apply(initialState, ev(chunk("otter", "x")));
    expect(s.pulses).toHaveLength(1);
    expect(s.pulses[0]).toMatchObject({
      fromSession: "otter",
      correlationId: CORR,
      kind: "message-chunk",
    });
    expect(typeof s.pulses[0].at).toBe("number");
  });

  it("pushes no pulse for a replayed envelope but still counts it", () => {
    const s = apply(initialState, ev(chunk("otter", "x"), false));
    expect(s.pulses).toHaveLength(0);
    expect(s.streamMsgCount).toBe(1);
    expect(s.chat).toHaveLength(1);
  });

  it("counts every envelope, live or replayed", () => {
    const s = apply(
      initialState,
      ev(chunk("otter", "a"), false),
      ev(chunk("otter", "b"), true),
      ev(card("otter")),
    );
    expect(s.streamMsgCount).toBe(3);
  });

  it("does not count ticks or heartbeats", () => {
    const s = apply(
      initialState,
      { type: "tick", now: 1 },
      { type: "heartbeat", session: "otter", at: 1 },
    );
    expect(s.streamMsgCount).toBe(0);
  });

  it("caps pulses at 200, keeping the most recent", () => {
    let s: UiState = initialState;
    for (let i = 0; i < 250; i++) s = reduce(s, ev(chunk("otter", `c${i}`, `task-${i}`)));
    expect(s.pulses).toHaveLength(200);
    expect(s.streamMsgCount).toBe(250);
    const ids = s.pulses.map((p) => p.id);
    expect(new Set(ids).size).toBe(200);
    expect(ids[ids.length - 1]).toBeGreaterThan(ids[0]);
  });

  it("gives pulses monotonically increasing ids", () => {
    const s = apply(initialState, ev(chunk("otter", "a")), ev(chunk("otter", "b", "task-2")));
    expect(s.pulses[1].id).toBeGreaterThan(s.pulses[0].id);
  });
});

describe("reduce: purity", () => {
  it("never mutates the state it is handed", () => {
    const before = apply(initialState, ev(card("otter")), ev(chunk("chatops", "hi")));
    const snapshot = JSON.stringify({
      agents: [...before.agents],
      tasks: [...before.tasks],
      chat: before.chat,
      pulses: before.pulses,
      count: before.streamMsgCount,
    });
    const after = reduce(before, ev(chunk("chatops", "there")));
    expect(after).not.toBe(before);
    expect(
      JSON.stringify({
        agents: [...before.agents],
        tasks: [...before.tasks],
        chat: before.chat,
        pulses: before.pulses,
        count: before.streamMsgCount,
      }),
    ).toBe(snapshot);
  });

  it("leaves initialState empty after use", () => {
    apply(initialState, ev(card("otter")));
    expect(initialState.agents.size).toBe(0);
    expect(initialState.chat).toHaveLength(0);
    expect(initialState.pulses).toHaveLength(0);
    expect(initialState.streamMsgCount).toBe(0);
  });
});

describe("corrColor", () => {
  it("returns a CSS hsl string", () => {
    expect(corrColor("corr-abc")).toMatch(/^hsl\(\d{1,3} 70% 60%\)$/);
  });

  it("is deterministic for the same correlation id", () => {
    expect(corrColor("corr-abc")).toBe(corrColor("corr-abc"));
  });

  it("usually differs across correlation ids", () => {
    const colors = new Set(
      Array.from({ length: 40 }, (_, i) => corrColor(`corr-0000000${i}-abcd`)),
    );
    expect(colors.size).toBeGreaterThan(30);
  });

  it("handles the empty string without throwing", () => {
    expect(corrColor("")).toMatch(/^hsl\(\d{1,3} 70% 60%\)$/);
  });
});
