import { describe, expect, it } from "vitest";
import { makeEnvelope, type Envelope } from "@a2a-demo/protocol/src/envelope.ts";
import {
  type BusEvent,
  type UiState,
  corrColor,
  initialState,
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
