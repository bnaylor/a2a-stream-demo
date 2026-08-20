import { describe, expect, it } from "vitest";
import { makeEnvelope, type Envelope } from "@a2a-demo/protocol/src/envelope.ts";
import {
  CHATOPS_SESSION,
  WEB_SESSION,
  initialState,
  reduce,
  type BusEvent,
  type UiState,
} from "./model.ts";
import {
  MAX_GHOST_STEPS,
  MIN_WORKER_PITCH,
  WORKER_PITCH,
  buildGhost,
  layoutTaps,
  type TapPosition,
} from "./rail-layout.ts";

const WIDE = 1400;

function workers(...sessions: string[]): { session: string }[] {
  return sessions.map((session) => ({ session }));
}

function xOf(taps: TapPosition[], session: string): number {
  const tap = taps.find((t) => t.session === session);
  if (!tap) throw new Error(`no tap for ${session}`);
  return tap.x;
}

describe("layoutTaps: fixed taps", () => {
  it("always emits you then chatops, even with no agents", () => {
    const taps = layoutTaps([], WIDE);
    expect(taps.map((t) => t.session)).toEqual([WEB_SESSION, CHATOPS_SESSION]);
    expect(taps.map((t) => t.kind)).toEqual(["you", "chatops"]);
  });

  it("puts you leftmost and chatops to its right", () => {
    const taps = layoutTaps(workers("otter"), WIDE);
    expect(xOf(taps, WEB_SESSION)).toBeLessThan(xOf(taps, CHATOPS_SESSION));
    expect(xOf(taps, CHATOPS_SESSION)).toBeLessThan(xOf(taps, "otter"));
  });

  it("does not duplicate chatops when it also arrives as an agent", () => {
    const taps = layoutTaps(workers("otter", CHATOPS_SESSION, "lynx"), WIDE);
    expect(taps.filter((t) => t.session === CHATOPS_SESSION)).toHaveLength(1);
    expect(taps.map((t) => t.session)).toEqual([WEB_SESSION, CHATOPS_SESSION, "otter", "lynx"]);
  });

  it("never lets a stray `you` agent become a second tap", () => {
    const taps = layoutTaps(workers(WEB_SESSION, "otter"), WIDE);
    expect(taps.filter((t) => t.session === WEB_SESSION)).toHaveLength(1);
  });
});

describe("layoutTaps: worker ordering", () => {
  it("lays workers out left to right in arrival order", () => {
    const taps = layoutTaps(workers("otter", "lynx", "vole"), WIDE);
    expect(taps.map((t) => t.session)).toEqual([WEB_SESSION, CHATOPS_SESSION, "otter", "lynx", "vole"]);
    expect(xOf(taps, "otter")).toBeLessThan(xOf(taps, "lynx"));
    expect(xOf(taps, "lynx")).toBeLessThan(xOf(taps, "vole"));
  });

  it("is deterministic for the same input", () => {
    const input = workers("otter", "lynx");
    expect(layoutTaps(input, WIDE)).toEqual(layoutTaps(input, WIDE));
  });

  it("holds existing workers still when a new one arrives", () => {
    const before = layoutTaps(workers("otter", "lynx"), WIDE);
    const after = layoutTaps(workers("otter", "lynx", "vole"), WIDE);
    expect(xOf(after, "otter")).toBe(xOf(before, "otter"));
    expect(xOf(after, "lynx")).toBe(xOf(before, "lynx"));
  });

  it("spaces workers at the natural pitch while they fit", () => {
    const taps = layoutTaps(workers("a", "b", "c"), WIDE);
    expect(xOf(taps, "b") - xOf(taps, "a")).toBe(WORKER_PITCH);
    expect(xOf(taps, "c") - xOf(taps, "b")).toBe(WORKER_PITCH);
  });

  it("does not mutate the agent list it is handed", () => {
    const input = workers("otter", "lynx");
    const copy = input.map((a) => ({ ...a }));
    layoutTaps(input, WIDE);
    expect(input).toEqual(copy);
  });
});

describe("layoutTaps: compression", () => {
  it("leaves six workers uncompressed at 1400px", () => {
    const taps = layoutTaps(workers("a", "b", "c", "d", "e", "f"), WIDE);
    expect(taps.every((t) => !t.compressed)).toBe(true);
  });

  it("compresses the pitch past six workers at 1400px", () => {
    const taps = layoutTaps(workers("a", "b", "c", "d", "e", "f", "g"), WIDE);
    const pitch = xOf(taps, "b") - xOf(taps, "a");
    expect(pitch).toBeLessThan(WORKER_PITCH);
    expect(taps.some((t) => t.compressed)).toBe(true);
  });

  it("keeps every tap inside the rail when compressed", () => {
    const taps = layoutTaps(workers("a", "b", "c", "d", "e", "f", "g", "h", "i"), WIDE);
    for (const tap of taps) {
      expect(tap.x).toBeGreaterThanOrEqual(0);
      expect(tap.x).toBeLessThanOrEqual(WIDE);
    }
  });

  it("never squeezes tighter than the minimum pitch", () => {
    const taps = layoutTaps(workers(...Array.from({ length: 40 }, (_, i) => `w${i}`)), WIDE);
    const xs = taps.filter((t) => t.kind === "worker").map((t) => t.x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(MIN_WORKER_PITCH);
    }
  });

  it("drops the oldest workers rather than overflowing the rail", () => {
    const many = Array.from({ length: 40 }, (_, i) => `w${i}`);
    const taps = layoutTaps(workers(...many), WIDE);
    const shown = taps.filter((t) => t.kind === "worker").map((t) => t.session);
    expect(shown.length).toBeLessThan(many.length);
    expect(shown[shown.length - 1]).toBe("w39");
    expect(taps.every((t) => t.x <= WIDE)).toBe(true);
  });

  it("still fits both fixed taps on a narrow rail", () => {
    const taps = layoutTaps(workers("otter"), 420);
    expect(xOf(taps, WEB_SESSION)).toBeLessThan(xOf(taps, CHATOPS_SESSION));
    expect(xOf(taps, CHATOPS_SESSION)).toBeLessThan(xOf(taps, "otter"));
    for (const tap of taps) expect(tap.x).toBeLessThanOrEqual(420);
  });

  it("returns integer coordinates", () => {
    const taps = layoutTaps(workers("otter", "lynx", "vole"), 1337);
    for (const tap of taps) expect(Number.isInteger(tap.x)).toBe(true);
  });
});

// --- ghost replay -----------------------------------------------------------

const CORR = "corr-ghost";
const TASK = "task-ghost";
const ev = (env: Envelope, live = true): BusEvent => ({ type: "envelope", env, live });

function card(session: string): Envelope {
  return makeEnvelope({
    kind: "agent-card",
    correlationId: CORR,
    from: { session, agentType: "claude-code" },
    payload: { session, agentType: "claude-code", owner: "bnaylor", startedAt: "2026-08-20T00:00:00.000Z" },
  });
}

function chunk(session: string, text: string): Envelope {
  return makeEnvelope({
    kind: "message-chunk",
    correlationId: CORR,
    taskId: TASK,
    contextId: "ctx-ghost",
    from: { session, agentType: "claude-code" },
    payload: { role: "agent", parts: [{ kind: "text", text }], messageId: "m1" },
  });
}

function status(session: string, state: "working" | "completed", final: boolean): Envelope {
  return makeEnvelope({
    kind: "status-update",
    correlationId: CORR,
    taskId: TASK,
    contextId: "ctx-ghost",
    from: { session, agentType: "claude-code" },
    payload: { taskId: TASK, contextId: "ctx-ghost", final, status: { state } },
  });
}

function artifact(session: string): Envelope {
  return makeEnvelope({
    kind: "artifact-update",
    correlationId: CORR,
    taskId: TASK,
    contextId: "ctx-ghost",
    from: { session, agentType: "claude-code" },
    payload: { artifactId: "a1", name: "report", parts: [{ kind: "text", text: "done" }] },
  });
}

function apply(state: UiState, ...events: BusEvent[]): UiState {
  return events.reduce(reduce, state);
}

describe("buildGhost", () => {
  it("returns nothing for a session with no traffic", () => {
    expect(buildGhost(initialState, "nobody")).toEqual([]);
  });

  it("replays the live pulses of that session in order", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(status("otter", "working", false)),
      ev(chunk("otter", "digging")),
      ev(artifact("otter")),
      ev(status("otter", "completed", true)),
    );
    const steps = buildGhost(s, "otter");
    expect(steps.map((g) => g.kind)).toEqual([
      "agent-card",
      "status-update",
      "message-chunk",
      "artifact-update",
      "status-update",
    ]);
    expect(steps.every((g) => g.correlationId === CORR)).toBe(true);
    expect(steps.every((g) => g.label.length > 0)).toBe(true);
  });

  it("keeps the most recent steps when a session has more than the cap", () => {
    let s = initialState;
    for (let i = 0; i < MAX_GHOST_STEPS + 10; i++) s = reduce(s, ev(chunk("otter", `c${i}`)));
    s = reduce(s, ev(status("otter", "completed", true)));
    const steps = buildGhost(s, "otter");
    expect(steps).toHaveLength(MAX_GHOST_STEPS);
    // The terminal event is the payoff of a replay; it must survive the cap.
    expect(steps[steps.length - 1].kind).toBe("status-update");
  });

  it("ignores other sessions' pulses", () => {
    const s = apply(initialState, ev(chunk("otter", "a")), ev(chunk("lynx", "b")));
    expect(buildGhost(s, "otter")).toHaveLength(1);
  });

  it("reconstructs from task state when the traffic was replayed history", () => {
    // live: false — history rebuilds state but leaves no pulses behind.
    const s = apply(
      initialState,
      ev(card("otter"), false),
      ev(status("otter", "working", false), false),
      ev(chunk("otter", "digging"), false),
      ev(artifact("otter"), false),
      ev(status("otter", "completed", true), false),
    );
    expect(s.pulses).toHaveLength(0);
    const steps = buildGhost(s, "otter");
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.map((g) => g.kind)).toContain("artifact-update");
    expect(steps[steps.length - 1].label).toContain("completed");
    expect(steps.every((g) => g.correlationId === CORR)).toBe(true);
  });

  // Eleven chips all reading "chunk" say nothing about what was replayed; the
  // excerpt is what turns the strip back into a readable trace.
  it("carries the first line of each replayed chunk", () => {
    const s = apply(
      initialState,
      ev(card("otter")),
      ev(chunk("otter", "reading the manifest\nand then some more")),
    );
    const steps = buildGhost(s, "otter");
    expect(steps[0].excerpt).toBeUndefined(); // agent-card has no text
    expect(steps[1].excerpt).toBe("reading the manifest");
  });

  it("elides a long chunk to a single readable line", () => {
    const s = apply(initialState, ev(chunk("otter", "x".repeat(400))));
    const excerpt = buildGhost(s, "otter")[0].excerpt ?? "";
    expect(excerpt).toHaveLength(80);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("carries excerpts on the reconstructed path too", () => {
    const s = apply(
      initialState,
      ev(card("otter"), false),
      ev(chunk("otter", "digging through the spec"), false),
      ev(artifact("otter"), false),
      ev(status("otter", "completed", true), false),
    );
    const steps = buildGhost(s, "otter");
    expect(steps.map((g) => g.excerpt)).toContain("digging through the spec");
    expect(steps.map((g) => g.excerpt)).toContain("done");
  });

  it("leaves the excerpt off steps that carried no text", () => {
    const s = apply(initialState, ev(card("otter"), false), ev(status("otter", "working", false), false));
    const steps = buildGhost(s, "otter");
    expect(steps.every((g) => g.kind !== "status-update" || g.excerpt === undefined)).toBe(true);
  });

  it("labels statuses with their state", () => {
    const s = apply(initialState, ev(card("otter"), false), ev(status("otter", "completed", true), false));
    const labels = buildGhost(s, "otter").map((g) => g.label);
    expect(labels.some((l) => l.includes("completed"))).toBe(true);
  });
});
