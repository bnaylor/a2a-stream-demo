/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeEnvelope, type Envelope } from "@a2a-demo/protocol/src/envelope.ts";
import { initialState, reduce, type BusEvent, type UiState } from "./model.ts";
import { MIN_WORKER_PITCH } from "./rail-layout.ts";
import Rail from "./Rail.tsx";

const CORR = "corr-rail";

beforeAll(() => {
  // jsdom has no layout engine and therefore no ResizeObserver; the rail only
  // uses it to learn its own width, and falls back to a minimum without it.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  // Restore before dropping the fake clock, and unconditionally: a spy left on
  // a torn-down fake `requestAnimationFrame` breaks every test after it.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function card(session: string): Envelope {
  return makeEnvelope({
    kind: "agent-card",
    correlationId: CORR,
    from: { session, agentType: "claude-code" },
    payload: { session, agentType: "claude-code", owner: "bnaylor", startedAt: "2026-08-20T00:00:00Z" },
  });
}

function chunk(session: string, text: string, taskId: string): Envelope {
  return makeEnvelope({
    kind: "message-chunk",
    correlationId: CORR,
    taskId,
    contextId: "ctx",
    from: { session, agentType: "claude-code" },
    payload: { role: "agent", parts: [{ kind: "text", text }], messageId: "m1" },
  });
}

function closedCard(session: string): Envelope {
  return makeEnvelope({
    kind: "agent-closed",
    correlationId: CORR,
    from: { session, agentType: "claude-code" },
    payload: { session },
  });
}

function status(session: string, state: "working" | "completed", final: boolean): Envelope {
  return makeEnvelope({
    kind: "status-update",
    correlationId: CORR,
    taskId: "t1",
    contextId: "ctx",
    from: { session, agentType: "claude-code" },
    payload: { taskId: "t1", contextId: "ctx", final, status: { state } },
  });
}

const ev = (env: Envelope): BusEvent => ({ type: "envelope", env, live: true });

/** Two workers mid-conversation, with live pulses queued behind them. */
function seeded(): UiState {
  return [
    ev(card("chatops")),
    ev(card("otter")),
    ev(card("lynx")),
    ev(chunk("otter", "[progress] fetching spec 2/2", "t1")),
    ev(chunk("lynx", "reading manifests", "t2")),
  ].reduce(reduce, initialState);
}

describe("Rail", () => {
  it("renders the seeded topology: both workers, their status lines and the counter", () => {
    render(<Rail state={seeded()} />);
    expect(screen.getByText("otter")).toBeDefined();
    expect(screen.getByText("lynx")).toBeDefined();
    expect(screen.getByText("you")).toBeDefined();
    expect(screen.getByText("chatops")).toBeDefined();
    // The worker's [progress] note is its tap's status line.
    expect(screen.getByText("fetching spec 2/2")).toBeDefined();
    expect(screen.getByText(/A2A stream · 5 msgs · 24h/)).toBeDefined();
  });

  it("exposes each agent tap to assistive tech as a named button", () => {
    const { container } = render(<Rail state={seeded()} />);
    expect(screen.getByRole("button", { name: "Replay otter events" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Replay lynx events" })).toBeDefined();
    // `you` is the observer, not an agent: focusable buttons only where there
    // is something to replay.
    expect(screen.queryByRole("button", { name: /Replay you events/ })).toBeNull();

    // The queries above pass even with role="img" on the wrapper, because
    // dom-testing-library does not model the presentational-children rule that
    // makes a real screen reader drop those buttons. Assert the wrapper's role
    // directly, or the regression is invisible here.
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("group");
    expect(svg?.getAttribute("aria-label")).toBe("NATS bus topology");
  });

  it("reports the browser's own link on the you tap", () => {
    const up = reduce(seeded(), { type: "connection", state: "up" });
    const { rerender, container } = render(<Rail state={up} />);
    expect(screen.getByText("websocket")).toBeDefined();

    // A dead link must be visible on the rail, not just in the console.
    rerender(<Rail state={reduce(up, { type: "connection", state: "down" })} />);
    expect(screen.getByText("link down")).toBeDefined();
    expect(container.querySelector(".tap-you")?.getAttribute("class")).toContain("tap-stale");

    rerender(<Rail state={reduce(up, { type: "connection", state: "connecting" })} />);
    expect(screen.getByText("connecting")).toBeDefined();
  });

  it("runs a ghost replay from a tap click and names it in the footer", () => {
    vi.useFakeTimers();
    render(<Rail state={seeded()} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Replay otter events" }));
    });
    expect(screen.getByText(/replaying/)).toBeDefined();
    act(() => vi.advanceTimersByTime(200));
    // The first step has fired, so its label is on the timeline strip.
    expect(screen.getByText("chunk")).toBeDefined();
  });

  it("parks the animation loop between ghost steps", () => {
    // `performance` must be faked too: the loop measures flight age with
    // performance.now(), so without it no dot ever lands and the loop never
    // gets the chance to park.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    // One-step ghost: after its dot lands there is a quiet stretch before the
    // replay clears itself, and nothing should be asking for frames during it.
    const oneStep = [ev(card("chatops")), ev(card("lynx"))].reduce(reduce, initialState);
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    render(<Rail state={oneStep} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Replay lynx events" }));
    });
    act(() => vi.advanceTimersByTime(1_100)); // step fired, its dot has landed
    const framesRequested = raf.mock.calls.length;
    expect(framesRequested).toBeGreaterThan(0); // it did animate
    act(() => vi.advanceTimersByTime(150)); // still replaying, nothing moving
    expect(raf.mock.calls.length).toBe(framesRequested);
  });

  it("shows the replayed chunk's first line as each step plays", () => {
    vi.useFakeTimers();
    render(<Rail state={seeded()} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Replay lynx events" }));
    });
    // Step 0 is lynx's agent-card, which carries no text; step 1 is its chunk.
    act(() => vi.advanceTimersByTime(140));
    expect(screen.queryByText("reading manifests")).toBeNull();
    act(() => vi.advanceTimersByTime(140));
    expect(screen.getByText("reading manifests")).toBeDefined();
  });

  it("unmounts mid-replay without throwing or leaving timers behind", () => {
    vi.useFakeTimers();
    const { unmount } = render(<Rail state={seeded()} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Replay otter events" }));
    });
    act(() => vi.advanceTimersByTime(150));
    expect(() => unmount()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    // Nothing left to fire, and nothing that fires can touch a dead tree.
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
  });
});

// The user's report: "the active agent's current line is rendered directly
// underneath it, overlaps other text, and doesn't go away or change".
describe("Rail: tap status lines", () => {
  const progress = (session: string, note: string) =>
    ev(chunk(session, `[progress] ${note}`, "t1"));

  it("shows the live progress milestone while the worker runs", () => {
    const s = [ev(card("chatops")), ev(card("otter")), progress("otter", "Fetched 2 of 4")].reduce(
      reduce,
      initialState,
    );
    render(<Rail state={s} />);
    expect(screen.getByText("Fetched 2 of 4")).toBeDefined();
  });

  it("replaces it with the lifecycle state once the worker is done", () => {
    const s = [
      ev(card("chatops")),
      ev(card("otter")),
      progress("otter", "Fetched 2 of 4"),
      ev(status("otter", "completed", true)),
    ].reduce(reduce, initialState);
    render(<Rail state={s} />);
    expect(screen.queryByText("Fetched 2 of 4")).toBeNull();
    expect(screen.getByText("done")).toBeDefined();
  });

  it("replaces it with closed once the pod goes away", () => {
    const s = [
      ev(card("chatops")),
      ev(card("otter")),
      progress("otter", "Fetched 2 of 4"),
      ev(closedCard("otter")),
    ].reduce(reduce, initialState);
    render(<Rail state={s} />);
    expect(screen.queryByText("Fetched 2 of 4")).toBeNull();
    expect(screen.getByText("closed")).toBeDefined();
  });

  // Unclipped, a worker-authored milestone runs straight through the labels of
  // the taps either side of it.
  it("clips an overlong milestone to the tap's own slot", () => {
    const long =
      "Starting research: what's a good place for brunch in Toronto on the weekends with parking";
    const s = [ev(card("chatops")), ev(card("otter")), ev(card("lynx")), progress("otter", long)]
      .reduce(reduce, initialState);
    const { container } = render(<Rail state={s} />);
    const status_ = Array.from(container.querySelectorAll(".tap-status")).map((n) => n.textContent ?? "");
    const shown = status_.find((t) => t.startsWith("Starting research"));
    expect(shown).toBeDefined();
    expect(shown!.length).toBeLessThan(long.length);
    expect(shown!.endsWith("…")).toBe(true);
    // Nothing on the rail may be wider than the slot it sits in.
    for (const t of status_) expect(t.length).toBeLessThanOrEqual(32);
  });

  it("never shows thinking text on the rail", () => {
    const s = [
      ev(card("chatops")),
      ev(card("otter")),
      ev(chunk("otter", "[thinking] Parking is the real constraint here", "t1")),
    ].reduce(reduce, initialState);
    const { container } = render(<Rail state={s} />);
    const status_ = Array.from(container.querySelectorAll(".tap-status")).map((n) => n.textContent ?? "");
    expect(status_.some((t) => t.includes("Parking"))).toBe(false);
    expect(status_).toContain("working");
  });
});

// Terminal taps used to fade off the rail on a two-second timer, which took
// their ghost replay with them — the reason replay "sometimes" wasn't there.
describe("Rail: terminal taps", () => {
  const done = () =>
    [ev(card("chatops")), ev(card("otter")), ev(status("otter", "completed", true))].reduce(
      reduce,
      initialState,
    );

  const gone = () =>
    [ev(card("chatops")), ev(card("otter")), ev(closedCard("otter"))].reduce(reduce, initialState);

  it("keeps a done worker on the rail, greyed, with its replay intact", () => {
    vi.useFakeTimers();
    const { container } = render(<Rail state={done()} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText("otter")).toBeDefined();
    expect(screen.getByText("done")).toBeDefined();
    expect(container.querySelector(".tap-done")).toBeDefined();
    expect(screen.getByRole("button", { name: "Replay otter events" })).toBeDefined();
  });

  it("keeps a closed worker on the rail indefinitely, with its replay intact", () => {
    vi.useFakeTimers();
    const { container } = render(<Rail state={gone()} />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("otter")).toBeDefined();
    expect(screen.getByText("closed")).toBeDefined();
    expect(container.querySelector(".tap-closed")).toBeDefined();
    expect(screen.getByRole("button", { name: "Replay otter events" })).toBeDefined();
  });

  it("offers a dismiss control on done and closed workers", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Rail state={done()} onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: "Dismiss otter" })).toBeDefined();
    rerender(<Rail state={gone()} onDismiss={onDismiss} />);
    expect(screen.getByRole("button", { name: "Dismiss otter" })).toBeDefined();
  });

  it("offers no dismiss control on a live worker or on chatops", () => {
    render(<Rail state={seeded()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Dismiss otter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss chatops" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss you" })).toBeNull();
  });

  it("dispatches dismiss for that session when the control is used", () => {
    const onDismiss = vi.fn();
    render(<Rail state={done()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss otter" }));
    expect(onDismiss).toHaveBeenCalledWith("otter");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses from the keyboard too", () => {
    const onDismiss = vi.fn();
    render(<Rail state={gone()} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss otter" }), { key: "Enter" });
    expect(onDismiss).toHaveBeenCalledWith("otter");
  });

  it("drops the tap once the reducer has dismissed the agent", () => {
    const { rerender } = render(<Rail state={done()} onDismiss={vi.fn()} />);
    expect(screen.getByText("otter")).toBeDefined();
    rerender(<Rail state={reduce(done(), { type: "dismiss", session: "otter" })} onDismiss={vi.fn()} />);
    expect(screen.queryByText("otter")).toBeNull();
    expect(screen.queryByRole("button", { name: "Replay otter events" })).toBeNull();
  });

  // The ✕ only exists while the slot is hovered, and in SVG an unpainted gap
  // is not hovered: without one continuous target the control blinks out as
  // the cursor travels from the label towards it.
  it("gives the slot one continuous hover target spanning dot, label and ✕", () => {
    const { container } = render(<Rail state={done()} onDismiss={vi.fn()} />);
    const slot = container.querySelector(".tap-slot .tap-hover-target") as SVGRectElement | null;
    expect(slot).not.toBeNull();

    const x = Number(slot?.getAttribute("x"));
    const y = Number(slot?.getAttribute("y"));
    const w = Number(slot?.getAttribute("width"));
    const h = Number(slot?.getAttribute("height"));

    // Full pitch wide, centred on the tap.
    expect(w).toBe(MIN_WORKER_PITCH);
    expect(x).toBe(-MIN_WORKER_PITCH / 2);

    // Tall enough to cover the ✕ above the rail and the status line below it.
    const dismiss = container.querySelector(".tap-dismiss circle") as SVGCircleElement | null;
    const cy = Number(dismiss?.getAttribute("cy"));
    const r = Number(dismiss?.getAttribute("r"));
    expect(y).toBeLessThanOrEqual(cy - r);
    const status = container.querySelector(".tap-status") as SVGTextElement | null;
    expect(y + h).toBeGreaterThanOrEqual(Number(status?.getAttribute("y")));

    // The ✕ sits inside it horizontally too.
    expect(Number(dismiss?.getAttribute("cx")) + r).toBeLessThanOrEqual(x + w);
  });

  it("puts the hover target behind the controls, and only where there is one", () => {
    const { container, rerender } = render(<Rail state={done()} onDismiss={vi.fn()} />);
    const slot = container.querySelector(".tap-slot:has(.tap-hover-target)");
    // First child: painted controls stay on top and keep their own clicks.
    expect(slot?.firstElementChild?.getAttribute("class")).toBe("tap-hover-target");

    // A live worker has nothing to dismiss, so it gets no extra hit area.
    rerender(<Rail state={seeded()} onDismiss={vi.fn()} />);
    expect(container.querySelector(".tap-hover-target")).toBeNull();
  });

  it("shows no dismiss control at all when the rail has no handler", () => {
    render(<Rail state={done()} />);
    expect(screen.queryByRole("button", { name: /^Dismiss/ })).toBeNull();
  });
});
