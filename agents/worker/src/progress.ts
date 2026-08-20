import { randomUUID } from "node:crypto";
import { Envelope, makeEnvelope } from "@a2a-demo/protocol";
import { TaskCtx } from "@a2a-demo/agents-common";

/** Progress notes are one-line milestones, not transcripts. */
export const PROGRESS_CHARS = 300;

/**
 * Backs the worker's `report_progress` tool. Each milestone goes out twice, on
 * purpose:
 *   - a `message-chunk`, so anyone tailing the task's stream sees it live;
 *   - a non-final `working` status-update carrying `metadata.progress`, so a
 *     cold replay (ChatOps answering "what is otter doing?") can recover the
 *     milestones without reconstructing them from chat text.
 */
export function makeProgressPublisher(
  publishEvent: (env: Envelope) => Promise<void>,
  ctx: TaskCtx
): (message: string) => Promise<void> {
  return async (message: string): Promise<void> => {
    const text = message.slice(0, PROGRESS_CHARS);
    await publishEvent(
      makeEnvelope({
        kind: "message-chunk",
        correlationId: ctx.correlationId,
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        from: ctx.from,
        payload: {
          role: "agent",
          parts: [{ kind: "text", text: `[progress] ${text}` }],
          messageId: `msg-${randomUUID()}`,
        },
      })
    );
    await publishEvent(
      makeEnvelope({
        kind: "status-update",
        correlationId: ctx.correlationId,
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        from: ctx.from,
        payload: {
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          final: false,
          status: { state: "working", timestamp: new Date().toISOString() },
          metadata: { progress: text },
        },
      })
    );
  };
}
