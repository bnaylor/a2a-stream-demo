/**
 * Builds the one envelope this UI ever publishes: a chat task addressed to
 * ChatOps. Mirrors `scripts/chat.ts` exactly — same kind, same addressing,
 * same payload shape — so the browser is just another terminal on the bus.
 *
 * Ids are minted here rather than imported from the protocol's `ids.ts`:
 * that module is built on `node:crypto` and cannot be bundled for a browser.
 * The prefixes (`task-`/`ctx-`/`corr-`) and the uuid shape match it.
 */
import { makeEnvelope, type Envelope } from "@a2a-demo/protocol/src/envelope.ts";
import { CHATOPS_SESSION, WEB_SESSION } from "./model.ts";

/**
 * `crypto.randomUUID` is secure-context-only and the demo is served over plain
 * http on a NodePort, so build the v4 out of `getRandomValues`, which is not.
 */
function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newTaskId = (): string => `task-${uuid()}`;
export const newContextId = (): string => `ctx-${uuid()}`;
export const newCorrelationId = (): string => `corr-${uuid()}`;

export interface ChatTask {
  env: Envelope;
  taskId: string;
  correlationId: string;
}

export function buildChatTask(text: string): ChatTask {
  const taskId = newTaskId();
  const contextId = newContextId();
  const correlationId = newCorrelationId();
  const env = makeEnvelope({
    kind: "task",
    correlationId,
    taskId,
    contextId,
    from: { session: WEB_SESSION, agentType: "human" },
    to: { session: CHATOPS_SESSION },
    payload: {
      id: taskId,
      contextId,
      prompt: text,
      status: { state: "submitted", timestamp: new Date().toISOString() },
    },
  });
  return { env, taskId, correlationId };
}
