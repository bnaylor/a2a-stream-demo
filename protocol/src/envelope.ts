export const PROTOCOL_VERSION = "a2a-jetstream/0.1";

export type EnvelopeKind =
  | "task" | "status-update" | "message-chunk"
  | "artifact-update" | "agent-card" | "agent-closed";

const KINDS: readonly EnvelopeKind[] = [
  "task", "status-update", "message-chunk", "artifact-update", "agent-card", "agent-closed",
];
const TASK_SCOPED: readonly EnvelopeKind[] = [
  "task", "status-update", "message-chunk", "artifact-update",
];

export interface EnvelopeFrom {
  session: string;
  agentType: string;
}

export interface Envelope<P = unknown> {
  protocol: typeof PROTOCOL_VERSION;
  correlationId: string;
  taskId?: string;
  contextId?: string;
  ts: string;
  from: EnvelopeFrom;
  kind: EnvelopeKind;
  payload: P;
}

export class EnvelopeError extends Error {}

export interface MakeEnvelopeInput<P> {
  kind: EnvelopeKind;
  correlationId: string;
  from: EnvelopeFrom;
  payload: P;
  taskId?: string;
  contextId?: string;
}

export function makeEnvelope<P>(input: MakeEnvelopeInput<P>): Envelope<P> {
  if (TASK_SCOPED.includes(input.kind) && (!input.taskId || !input.contextId)) {
    throw new EnvelopeError(`kind ${input.kind} requires taskId and contextId`);
  }
  return {
    protocol: PROTOCOL_VERSION,
    correlationId: input.correlationId,
    taskId: input.taskId,
    contextId: input.contextId,
    ts: new Date().toISOString(),
    from: input.from,
    kind: input.kind,
    payload: input.payload,
  };
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env));
}

export function parseEnvelope(data: Uint8Array | string): Envelope {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
  } catch {
    throw new EnvelopeError("envelope is not valid JSON");
  }
  const e = obj as Record<string, unknown>;
  if (e?.protocol !== PROTOCOL_VERSION) {
    throw new EnvelopeError(`unsupported protocol: ${String(e?.protocol)}`);
  }
  const from = e.from as Record<string, unknown> | undefined;
  if (
    typeof e.correlationId !== "string" || typeof e.ts !== "string" ||
    typeof from?.session !== "string" || typeof from?.agentType !== "string" ||
    !KINDS.includes(e.kind as EnvelopeKind) || typeof e.payload !== "object" || e.payload === null
  ) {
    throw new EnvelopeError("envelope missing required fields");
  }
  const kind = e.kind as EnvelopeKind;
  if (TASK_SCOPED.includes(kind) && (typeof e.taskId !== "string" || typeof e.contextId !== "string")) {
    throw new EnvelopeError(`kind ${kind} requires taskId and contextId`);
  }
  return {
    protocol: PROTOCOL_VERSION,
    correlationId: e.correlationId,
    taskId: e.taskId as string | undefined,
    contextId: e.contextId as string | undefined,
    ts: e.ts,
    from: { session: from.session, agentType: from.agentType },
    kind,
    payload: e.payload,
  };
}
