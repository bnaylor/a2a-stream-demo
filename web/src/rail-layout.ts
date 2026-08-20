/**
 * Pure geometry and derivations for the bus rail. No React, no clock, no DOM —
 * everything here is a function of `UiState` plus the pixel width the rail was
 * measured at, so the interesting parts of the visualisation are unit-testable.
 *
 * The rail reads left to right as a signal path: the observer (`you`) is
 * soldered on at the left, ChatOps next to it, and every worker taps in further
 * down the trace in the order it first spoke.
 */
import type { EnvelopeKind } from "@a2a-demo/protocol/src/envelope.ts";
import { CHATOPS_SESSION, WEB_SESSION, excerptOf, type UiState } from "./model.ts";

/** Clear space at each end of the trace. */
export const RAIL_PAD_LEFT = 64;
export const RAIL_PAD_RIGHT = 64;
/** `you` → `chatops`: the fixed head of the rail. */
export const CHATOPS_GAP = 180;
/** `chatops` → the first worker: a wider gap, so the fleet reads as a group. */
export const WORKER_GAP = 230;
/** Worker spacing while there is room for it. */
export const WORKER_PITCH = 160;
/** Below this, labels collide — the rail sheds its oldest taps instead. */
export const MIN_WORKER_PITCH = 84;
/** Width the fixed gaps are drawn at full size; narrower rails scale them down. */
const REFERENCE_SPAN = 900;
const MIN_GAP_SCALE = 0.45;
/** A ghost replay longer than this stops being legible and starts being a wait. */
export const MAX_GHOST_STEPS = 24;

/**
 * Mono advance width at the tap-status font size (9.5px). Used to turn a slot's
 * pixel budget into a character budget.
 */
export const STATUS_CHAR_PX = 5.3;

/**
 * Fits a label into `maxChars`, eliding with a single ellipsis. Below two
 * characters the ellipsis would be the whole budget, so the label is cut
 * instead; at zero or less there is no room for anything.
 *
 * A tap's status line is worker-authored text of arbitrary length sitting in a
 * fixed-width slot; unclipped it runs straight through its neighbours' labels.
 */
export function ellipsize(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars < 2) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * How much room each tap has for its labels. Labels are centred on the tap, so
 * a tap may use half the gap to each neighbour and no more — that is what stops
 * two labels claiming the same pixels. The end taps run out into the rail's
 * padding instead of into a neighbour.
 */
export function slotWidths(taps: readonly TapPosition[], railWidth: number): Map<string, number> {
  const widths = new Map<string, number>();
  taps.forEach((tap, i) => {
    const left = i > 0 ? tap.x - taps[i - 1].x : tap.x * 2;
    const right = i < taps.length - 1 ? taps[i + 1].x - tap.x : (railWidth - tap.x) * 2;
    // The tighter of the two gaps, less a hair of breathing room.
    widths.set(tap.session, Math.max(0, Math.min(left, right) - 8));
  });
  return widths;
}

export type TapKind = "you" | "chatops" | "worker";

/** Structural: any list of things with a session name can be laid out. */
export interface TapAgent {
  session: string;
}

export interface TapPosition {
  session: string;
  kind: TapKind;
  /** Pixel x on the rail, integral so hairlines stay crisp. */
  x: number;
  /** True when this tap sits closer than its natural spacing. */
  compressed: boolean;
}

/**
 * Fixed `you`/`chatops` taps, then workers left to right in arrival order.
 *
 * Positions are absolute rather than distributed: a tap that has been placed
 * never moves when a later one arrives, so the rail grows to the right instead
 * of reshuffling under the audience's eyes. Only when the fleet outgrows the
 * trace does the pitch tighten, and past the minimum pitch the rail keeps the
 * newest workers and drops the oldest off the left of the group.
 */
export function layoutTaps(agents: readonly TapAgent[], width: number): TapPosition[] {
  const span = Math.max(0, width - RAIL_PAD_LEFT - RAIL_PAD_RIGHT);
  const scale = Math.min(1, Math.max(MIN_GAP_SCALE, span / REFERENCE_SPAN));
  const youX = RAIL_PAD_LEFT;
  const chatopsX = youX + CHATOPS_GAP * scale;
  const workerStart = chatopsX + WORKER_GAP * scale;

  const taps: TapPosition[] = [
    { session: WEB_SESSION, kind: "you", x: Math.round(youX), compressed: scale < 1 },
    { session: CHATOPS_SESSION, kind: "chatops", x: Math.round(chatopsX), compressed: scale < 1 },
  ];

  const workers = agents.filter(
    (a) => a.session !== CHATOPS_SESSION && a.session !== WEB_SESSION,
  );
  if (workers.length === 0) return taps;

  const room = Math.max(0, width - RAIL_PAD_RIGHT - workerStart);
  const capacity = Math.max(1, Math.floor(room / MIN_WORKER_PITCH) + 1);
  const shown = workers.length > capacity ? workers.slice(workers.length - capacity) : workers;
  const pitch =
    shown.length > 1
      ? Math.max(MIN_WORKER_PITCH, Math.min(WORKER_PITCH, room / (shown.length - 1)))
      : WORKER_PITCH;
  const compressed = pitch < WORKER_PITCH || shown.length < workers.length;

  shown.forEach((worker, i) => {
    taps.push({
      session: worker.session,
      kind: "worker",
      x: Math.round(workerStart + i * pitch),
      compressed,
    });
  });

  return taps;
}

export interface GhostStep {
  kind: EnvelopeKind;
  /** Short label for the timeline strip, e.g. `status · completed`. */
  label: string;
  correlationId: string;
  /**
   * The first line of what this step actually carried, if it carried text.
   * A replay of eleven identical `chunk` chips says nothing; the excerpt is
   * what turns the strip back into a readable trace.
   */
  excerpt?: string;
}

const KIND_LABEL: Record<EnvelopeKind, string> = {
  "agent-card": "card",
  "agent-closed": "closed",
  task: "task",
  "status-update": "status",
  "message-chunk": "chunk",
  "artifact-update": "artifact",
};

/**
 * The event sequence a tap click replays. Nothing is re-fetched: live traffic
 * is already in `pulses`, and after a page reload — where history rebuilt the
 * state but left no pulses behind — the sequence is reconstructed from the
 * tasks, chat and artifacts that history did leave.
 */
export function buildGhost(state: UiState, session: string): GhostStep[] {
  const observed = state.pulses
    .filter((p) => p.fromSession === session)
    .map((p) => ({
      kind: p.kind,
      label: KIND_LABEL[p.kind],
      correlationId: p.correlationId,
      excerpt: p.excerpt,
    }));
  // The tail, not the head: the last thing a task did — the terminal status —
  // is the point of replaying it.
  if (observed.length > 0) return observed.slice(-MAX_GHOST_STEPS);

  const tasks = [...state.tasks.values()].filter((t) => t.owner === session);
  if (tasks.length === 0) return [];

  const steps: GhostStep[] = [];
  if (state.agents.has(session)) {
    steps.push({ kind: "agent-card", label: KIND_LABEL["agent-card"], correlationId: tasks[0].correlationId });
  }
  for (const task of tasks) {
    const corr = task.correlationId;
    steps.push({ kind: "status-update", label: "status · working", correlationId: corr });
    for (const entry of state.chat) {
      if (entry.taskId !== task.taskId || entry.session !== session) continue;
      steps.push({
        kind: "message-chunk",
        label: entry.kind === "progress" ? "chunk · progress" : "chunk",
        correlationId: corr,
        excerpt: excerptOf(entry.text) || undefined,
      });
    }
    for (const artifact of task.artifacts) {
      steps.push({
        kind: "artifact-update",
        label: `artifact · ${artifact.name ?? artifact.artifactId}`,
        correlationId: corr,
        excerpt:
          excerptOf(
            (artifact.parts ?? [])
              .map((p) => (p as { text?: string }).text ?? "")
              .join(""),
          ) || undefined,
      });
    }
    steps.push({ kind: "status-update", label: `status · ${task.state}`, correlationId: corr });
  }
  return steps.slice(-MAX_GHOST_STEPS);
}
