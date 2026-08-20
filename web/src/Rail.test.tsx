/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeEnvelope, type Envelope } from "@a2a-demo/protocol/src/envelope.ts";
import { initialState, reduce, type BusEvent, type UiState } from "./model.ts";
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
