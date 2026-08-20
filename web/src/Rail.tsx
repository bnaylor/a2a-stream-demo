/**
 * The bus rail: the demo's centrepiece and its only luminous surface.
 *
 * The rail is drawn as an instrument trace. Every participant is soldered to
 * it by a hairline lead, and every live envelope is a charge travelling the
 * trace toward the observer (`you`) — except the observer's own submissions,
 * which travel the other way, into ChatOps. Colour is spent on two things
 * only: which conversation a pulse belongs to (`corrColor`), and one amber
 * warning for an agent that has stopped heartbeating.
 *
 * Animation state lives in refs, never in the reducer: the rAF loop reads
 * `state.pulses` through an id watermark (browser time stamps the start, since
 * pod clocks drift) and the reducer never learns that the loop exists.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { EnvelopeKind } from "@a2a-demo/protocol/src/envelope.ts";
import {
  CHATOPS_SESSION,
  WEB_SESSION,
  corrColor,
  type AgentView,
  type ConnectionState,
  type UiState,
} from "./model.ts";
import {
  RAIL_PAD_LEFT,
  RAIL_PAD_RIGHT,
  buildGhost,
  layoutTaps,
  type GhostStep,
  type TapPosition,
} from "./rail-layout.ts";

const RAIL_Y = 54;
const LEAD_LEN = 28;
const NAME_Y = RAIL_Y + LEAD_LEN + 15;
const STATUS_Y = NAME_Y + 14;
const STRIP_Y = 132;
/** The replayed chunk's own first line, under the strip. */
const PEEK_Y = STRIP_Y + 32;
const SVG_HEIGHT = 184;
const FALLBACK_WIDTH = 1200;
/** Mono advance width at the peek's font size, for fitting text to the rail. */
const PEEK_CHAR_PX = 5.6;

/** One pulse's flight time, end to end. */
const PULSE_MS = 900;
/** Gap between ghost-replay steps — fast enough to read as a burst. */
const GHOST_STEP_MS = 120;
const RIPPLE_MS = 1100;
/** Fraction of the flight spent blooming into the destination tap. */
const BLOOM_FROM = 0.82;
const MAX_FLIGHTS = 64;
const NAME_MAX = 18;

/**
 * Bigger payload, bigger charge: the eye should sort kinds without a legend.
 * Sized up from the first pass — at the old scale a `message-chunk` was a
 * two-pixel dot with a short wake and read as noise on the trace rather than
 * as traffic. The ratios between kinds are unchanged; the whole set is louder.
 */
const PULSE_SHAPE: Record<EnvelopeKind, { r: number; wake: number }> = {
  "artifact-update": { r: 7.5, wake: 168 },
  task: { r: 6.5, wake: 138 },
  "agent-card": { r: 5.5, wake: 104 },
  "agent-closed": { r: 5.5, wake: 104 },
  "status-update": { r: 4.5, wake: 88 },
  "message-chunk": { r: 3.4, wake: 58 },
};

/** Ghosts are quieter than live traffic, but no longer invisible. */
const GHOST_SHAPE = { r: 4.4, wake: 76 };

interface Flight {
  key: string;
  x0: number;
  x1: number;
  r: number;
  wake: number;
  color: string;
  ghost: boolean;
  start: number;
}

interface Ripple {
  session: string;
  start: number;
}

interface GhostRun {
  session: string;
  steps: GhostStep[];
  index: number;
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function shortName(session: string): string {
  return session.length > NAME_MAX ? `${session.slice(0, NAME_MAX - 1)}…` : session;
}

/** The observer's tap reports the browser's own link, not an agent lifecycle. */
function linkText(connection: ConnectionState): string {
  switch (connection) {
    case "up":
      return "websocket";
    case "connecting":
      return "connecting";
    case "down":
      return "link down";
  }
}

function statusText(
  tap: TapPosition,
  agent: AgentView | undefined,
  connection: ConnectionState,
): string {
  if (tap.kind === "you") return linkText(connection);
  if (!agent) return "awaiting card";
  if (agent.statusLine) return agent.statusLine;
  switch (agent.status) {
    case "live":
      return tap.kind === "chatops" ? "routing" : "working";
    case "stale":
      return "no heartbeat";
    case "done":
      return "done";
    case "closed":
      return "closed";
  }
}

/** Clips the peek to whatever the rail can actually hold at this width. */
function fitPeek(text: string, railWidth: number): string {
  const max = Math.max(12, Math.floor(railWidth / PEEK_CHAR_PX));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Lays the replay chips out end to end, dropping any that run off the rail. */
function chipRow(steps: GhostStep[], railEnd: number) {
  const row: { step: GhostStep; i: number; x: number; w: number }[] = [];
  let x = RAIL_PAD_LEFT;
  steps.forEach((step, i) => {
    const w = Math.round(step.label.length * 5.6 + 18);
    if (x + w > railEnd) return;
    row.push({ step, i, x, w });
    x += w + 8;
  });
  return row;
}

interface RailProps {
  state: UiState;
  /** Retires a finished worker's tap. Absent in tests that only render. */
  onDismiss?: (session: string) => void;
}

export default function Rail({ state, onDismiss }: RailProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [, paint] = useReducer((n: number) => n + 1, 0);
  const [ghost, setGhost] = useState<GhostRun | null>(null);
  const reduced = useMemo(prefersReducedMotion, []);

  const flightsRef = useRef<Flight[]>([]);
  const ripplesRef = useRef<Ripple[]>([]);
  const watermarkRef = useRef(0);
  const heartbeatsRef = useRef(new Map<string, number>());
  const rafRef = useRef<number | null>(null);

  // --- measure ---------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(Math.max(480, Math.round(host.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // --- who is on the rail ----------------------------------------------------
  // Every agent the reducer knows about, for as long as it knows about it. A
  // finished worker's tap used to fade off the trace on a two-second timer,
  // which took its ghost replay with it — the demo's best affordance,
  // available only if you clicked fast enough. Taps now leave by one route
  // only: the user dismissing them.
  const visible = useMemo(() => [...state.agents.values()], [state.agents]);

  const taps = useMemo(() => layoutTaps(visible, width), [visible, width]);
  const tapX = useMemo(() => new Map(taps.map((t) => [t.session, t.x])), [taps]);

  // --- the animation loop ----------------------------------------------------
  const runLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const step = () => {
      const now = performance.now();
      flightsRef.current = flightsRef.current.filter((f) => now - f.start < PULSE_MS);
      ripplesRef.current = ripplesRef.current.filter((r) => now - r.start < RIPPLE_MS);
      // Only ever runs while something is actually moving. A ghost replay is a
      // chain of setTimeouts, so the loop parks itself between steps and each
      // `launch` wakes it again.
      const busy = flightsRef.current.length > 0 || ripplesRef.current.length > 0;
      rafRef.current = busy ? requestAnimationFrame(step) : null;
      paint();
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const launch = useCallback(
    (from: string, kind: EnvelopeKind, color: string, ghostly: boolean, key: string) => {
      const edge = width - RAIL_PAD_RIGHT;
      const x0 = tapX.get(from) ?? edge;
      // Everything reports to the observer; the observer's own traffic is the
      // one thing that flows the other way, into ChatOps.
      const x1 =
        from === WEB_SESSION
          ? (tapX.get(CHATOPS_SESSION) ?? edge)
          : (tapX.get(WEB_SESSION) ?? RAIL_PAD_LEFT);
      const shape = ghostly ? GHOST_SHAPE : PULSE_SHAPE[kind];
      flightsRef.current.push({
        key,
        x0,
        x1,
        r: shape.r,
        wake: shape.wake,
        color,
        ghost: ghostly,
        start: performance.now(),
      });
      if (flightsRef.current.length > MAX_FLIGHTS) {
        flightsRef.current = flightsRef.current.slice(-MAX_FLIGHTS);
      }
      runLoop();
    },
    [runLoop, tapX, width],
  );

  // Pulses are consumed by id watermark, not by timestamp: pod clocks skew, but
  // the reducer's ids only ever climb.
  useEffect(() => {
    let launched = false;
    for (const pulse of state.pulses) {
      if (pulse.id <= watermarkRef.current) continue;
      watermarkRef.current = pulse.id;
      launch(pulse.fromSession, pulse.kind, corrColor(pulse.correlationId), false, `p${pulse.id}`);
      launched = true;
    }
    if (launched) runLoop();
  }, [state.pulses, launch, runLoop]);

  // Heartbeats never reach the pulse queue — they show up as a change in
  // lastHeartbeat, and the first one seen is skipped so a reconnect doesn't
  // ripple the whole fleet at once.
  useEffect(() => {
    let rippled = false;
    for (const [session, agent] of state.agents) {
      if (agent.lastHeartbeat === undefined) continue;
      const seen = heartbeatsRef.current.get(session);
      heartbeatsRef.current.set(session, agent.lastHeartbeat);
      if (seen === undefined || seen === agent.lastHeartbeat) continue;
      ripplesRef.current.push({ session, start: performance.now() });
      rippled = true;
    }
    if (rippled) runLoop();
  }, [state.agents, runLoop]);

  // --- ghost replay ----------------------------------------------------------
  const startGhost = useCallback(
    (session: string) => {
      const steps = buildGhost(state, session);
      if (steps.length === 0) return;
      setGhost({ session, steps, index: -1 });
    },
    [state],
  );

  useEffect(() => {
    if (!ghost) return;
    if (ghost.index >= ghost.steps.length - 1) {
      const done = setTimeout(() => setGhost(null), PULSE_MS + 300);
      return () => clearTimeout(done);
    }
    const next = setTimeout(() => {
      const i = ghost.index + 1;
      const step = ghost.steps[i];
      launch(ghost.session, step.kind, "", true, `g${ghost.session}-${i}`);
      setGhost((g) => (g && g.session === ghost.session ? { ...g, index: i } : g));
    }, GHOST_STEP_MS);
    return () => clearTimeout(next);
  }, [ghost, launch]);

  // --- render ----------------------------------------------------------------
  const now = performance.now();
  const railEnd = width - RAIL_PAD_RIGHT;

  const flights = flightsRef.current.map((f) => {
    const p = Math.min(1, Math.max(0, (now - f.start) / PULSE_MS));
    const x = reduced ? f.x0 : f.x0 + (f.x1 - f.x0) * p;
    const dir = f.x1 >= f.x0 ? 1 : -1;
    const wake = reduced ? 0 : f.wake * Math.min(1, p * 4);
    const opacity = Math.min(1, p / 0.06) * Math.min(1, (1 - p) / 0.18) * (f.ghost ? 0.8 : 1);
    // The last stretch of the flight lands: a short ring at the destination
    // tap, so an arrival is something you catch out of the corner of your eye
    // rather than something you have to already be watching for.
    const bloom = reduced || p < BLOOM_FROM ? 0 : (p - BLOOM_FROM) / (1 - BLOOM_FROM);
    return { ...f, x, dir, wake, opacity, bloom };
  });

  const ripplePhase = new Map<string, number>();
  for (const r of ripplesRef.current) {
    ripplePhase.set(r.session, Math.min(1, (now - r.start) / RIPPLE_MS));
  }

  const current = ghost && ghost.index >= 0 ? ghost.steps[ghost.index] : undefined;
  const ghostCorr = ghost?.steps[Math.max(0, ghost.index)]?.correlationId ?? "";
  const peek = current?.excerpt ?? "";

  return (
    <div className="rail-panel" ref={hostRef}>
      <div className="rail-head">
        <span className="rail-title">NATS JetStream</span>
        <span className="rail-subject">a2a.&gt;</span>
      </div>

      {/* role="group", never "img": the taps inside are real buttons, and an
          img role would flatten them out of the accessibility tree while
          leaving them tab-focusable. */}
      <svg
        className="rail-svg"
        width={width}
        height={SVG_HEIGHT}
        viewBox={`0 0 ${width} ${SVG_HEIGHT}`}
        role="group"
        aria-label="NATS bus topology"
      >
        <defs>
          <filter id="rail-glow" x="-60%" y="-400%" width="220%" height="900%">
            <feGaussianBlur stdDeviation="4.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <line
          className="rail-trace-halo"
          x1={RAIL_PAD_LEFT}
          x2={railEnd}
          y1={RAIL_Y}
          y2={RAIL_Y}
        />
        <line className="rail-trace" x1={RAIL_PAD_LEFT} x2={railEnd} y1={RAIL_Y} y2={RAIL_Y} />
        <line
          className="rail-terminator"
          x1={RAIL_PAD_LEFT}
          x2={RAIL_PAD_LEFT}
          y1={RAIL_Y - 6}
          y2={RAIL_Y + 6}
        />
        <line
          className="rail-terminator"
          x1={railEnd}
          x2={railEnd}
          y1={RAIL_Y - 6}
          y2={RAIL_Y + 6}
        />

        {taps.map((tap) => {
          const agent = state.agents.get(tap.session);
          // A broken link borrows the stale look — same amber, same meaning:
          // this tap is not telling you the truth right now.
          const status =
            tap.kind === "you"
              ? state.connection === "up"
                ? "live"
                : "stale"
              : (agent?.status ?? "absent");
          const phase = ripplePhase.get(tap.session);
          const clickable = tap.kind !== "you" && agent !== undefined;
          // Terminal workers are the user's to clear; live ones are not, and
          // ChatOps outlives every turn.
          const dismissable =
            tap.kind === "worker" &&
            onDismiss !== undefined &&
            (status === "done" || status === "closed");
          return (
            // Two groups on purpose: the outer one carries the x position as an
            // attribute, the inner one owns the CSS transform the lifecycle
            // animations drive — a CSS transform would otherwise replace the
            // attribute and snap the tap to x=0.
            <g key={tap.session} className="tap-slot" transform={`translate(${tap.x} 0)`}>
            <g
              className={`tap tap-${tap.kind} tap-${status}${clickable ? " tap-clickable" : ""}`}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `Replay ${tap.session} events` : undefined}
              onClick={clickable ? () => startGhost(tap.session) : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        startGhost(tap.session);
                      }
                    }
                  : undefined
              }
            >
              <line className="tap-lead" x1={0} x2={0} y1={RAIL_Y} y2={RAIL_Y + LEAD_LEN} />
              {phase !== undefined && (
                <circle
                  className="tap-ripple"
                  cx={0}
                  cy={RAIL_Y}
                  r={5 + phase * 16}
                  opacity={(1 - phase) * 0.5}
                />
              )}
              {tap.kind === "you" ? (
                <rect className="tap-port" x={-4.5} y={RAIL_Y - 4.5} width={9} height={9} />
              ) : (
                <circle className="tap-dot" cx={0} cy={RAIL_Y} r={tap.kind === "chatops" ? 5 : 4} />
              )}
              {tap.kind === "chatops" && <circle className="tap-hub" cx={0} cy={RAIL_Y} r={8.5} />}
              <text className="tap-name" x={0} y={NAME_Y} textAnchor="middle">
                {shortName(tap.session)}
                {/* The `?` asks "is this pod still there?" — never the right
                    question about the browser's own socket, which says so in
                    words on the line below. */}
                {status === "stale" && tap.kind !== "you" ? " ?" : ""}
              </text>
              <text className="tap-status" x={0} y={STATUS_Y} textAnchor="middle">
                {statusText(tap, agent, state.connection)}
              </text>
            </g>
            {/* A sibling, not a child, of the replay button: nesting one
                control inside another hides it from screen readers that honour
                the presentational-children rule. */}
            {dismissable && (
              <g
                className="tap-dismiss"
                role="button"
                tabIndex={0}
                aria-label={`Dismiss ${tap.session}`}
                onClick={() => onDismiss?.(tap.session)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onDismiss?.(tap.session);
                  }
                }}
              >
                <circle className="tap-dismiss-hit" cx={14} cy={RAIL_Y - 15} r={8} />
                <path className="tap-dismiss-x" d={`M ${11} ${RAIL_Y - 18} l 6 6 M ${17} ${RAIL_Y - 18} l -6 6`} />
              </g>
            )}
            </g>
          );
        })}

        {flights.map((f) => (
          <g key={f.key} className={f.ghost ? "pulse pulse-ghost" : "pulse"} opacity={f.opacity}>
            {f.bloom > 0 && (
              <circle
                className="pulse-bloom"
                cx={f.x1}
                cy={RAIL_Y}
                r={f.r + f.bloom * 15}
                stroke={f.ghost ? undefined : f.color}
                opacity={(1 - f.bloom) * 0.65}
              />
            )}
            {f.wake > 1 && (
              <line
                className="pulse-wake"
                x1={f.x - f.dir * f.wake}
                x2={f.x}
                y1={RAIL_Y}
                y2={RAIL_Y}
                stroke={f.ghost ? undefined : f.color}
                strokeWidth={Math.max(1.4, f.r * 1.1)}
              />
            )}
            <circle
              className="pulse-head"
              cx={f.x}
              cy={RAIL_Y}
              r={f.r}
              fill={f.ghost ? undefined : f.color}
              filter={f.ghost ? undefined : "url(#rail-glow)"}
            />
            {/* White-hot centre: the charge reads as lit rather than painted. */}
            <circle className="pulse-core" cx={f.x} cy={RAIL_Y} r={Math.max(1, f.r * 0.42)} />
          </g>
        ))}

        {ghost && (
          <g className="ghost-strip">
            {chipRow(ghost.steps, railEnd).map(({ step, i, x, w }) => (
              <g key={`${step.label}-${i}`} className={i <= ghost.index ? "chip chip-on" : "chip"}>
                <rect x={x} y={STRIP_Y} width={w} height={18} rx={2} />
                <text x={x + 8} y={STRIP_Y + 13}>
                  {step.label}
                </text>
              </g>
            ))}
            {/* What the step in flight actually carried. Chips alone say
                "chunk, chunk, chunk"; this says what was in them. */}
            {peek && (
              <text className="ghost-peek" x={RAIL_PAD_LEFT} y={PEEK_Y}>
                {fitPeek(peek, railEnd - RAIL_PAD_LEFT)}
              </text>
            )}
          </g>
        )}
      </svg>

      <div className="rail-foot">
        <span className="rail-count">
          A2A stream · {state.streamMsgCount.toLocaleString()} msgs · 24h
        </span>
        {ghost && (
          <span className="rail-replay">▓▓░ replaying {ghostCorr.slice(0, 8) || ghost.session}</span>
        )}
      </div>
    </div>
  );
}
