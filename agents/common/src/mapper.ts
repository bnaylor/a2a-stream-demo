import { randomUUID } from "node:crypto";
import {
  Envelope,
  EnvelopeFrom,
  makeEnvelope,
  A2AMessage,
  Artifact,
  TaskStatusUpdate,
} from "@a2a-demo/protocol";

export interface SdkMsg {
  type: string;
  subtype?: string;
  result?: string;
  event?: {
    type: string;
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
    };
  };
  message?: {
    content: {
      type: string;
      name?: string;
      text?: string;
    }[];
  };
}

export interface TaskCtx {
  taskId: string;
  contextId: string;
  correlationId: string;
  from: EnvelopeFrom;
}

function makeMessageId(): string {
  return `msg-${randomUUID()}`;
}

function makeArtifactId(taskId: string): string {
  return `artifact-${taskId}`;
}

export function mapSdkMessage(m: SdkMsg, ctx: TaskCtx): Envelope[] {
  // Handle stream_event with text_delta or thinking_delta
  if (
    m.type === "stream_event" &&
    m.event?.type === "content_block_delta"
  ) {
    const delta = m.event.delta;
    if (delta?.type === "text_delta" && delta.text !== undefined) {
      const msg: A2AMessage = {
        role: "agent",
        parts: [{ kind: "text", text: delta.text }],
        messageId: makeMessageId(),
      };
      return [
        makeEnvelope({
          kind: "message-chunk",
          correlationId: ctx.correlationId,
          from: ctx.from,
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          payload: msg,
        }),
      ];
    }
    if (delta?.type === "thinking_delta" && delta.thinking !== undefined) {
      const msg: A2AMessage = {
        role: "agent",
        parts: [{ kind: "text", text: `[thinking] ${delta.thinking}` }],
        messageId: makeMessageId(),
      };
      return [
        makeEnvelope({
          kind: "message-chunk",
          correlationId: ctx.correlationId,
          from: ctx.from,
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          payload: msg,
        }),
      ];
    }
  }

  // Handle assistant message with tool_use blocks
  if (m.type === "assistant" && m.message?.content) {
    const toolUses = m.message.content.filter((c) => c.type === "tool_use");
    if (toolUses.length > 0) {
      const envelopes: Envelope[] = [];
      for (const toolUse of toolUses) {
        const statusUpdate: TaskStatusUpdate = {
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          status: {
            state: "working",
            timestamp: new Date().toISOString(),
          },
          final: false,
        };
        envelopes.push(
          makeEnvelope({
            kind: "status-update",
            correlationId: ctx.correlationId,
            from: ctx.from,
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            payload: {
              ...statusUpdate,
              metadata: { tool: toolUse.name },
            } as any,
          })
        );
      }
      return envelopes;
    }
  }

  // Handle result with success subtype
  if (m.type === "result" && m.subtype === "success" && m.result !== undefined) {
    const envelopes: Envelope[] = [];

    // First, artifact-update
    const artifact: Artifact = {
      artifactId: makeArtifactId(ctx.taskId),
      parts: [{ kind: "text", text: m.result }],
    };
    envelopes.push(
      makeEnvelope({
        kind: "artifact-update",
        correlationId: ctx.correlationId,
        from: ctx.from,
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        payload: artifact,
      })
    );

    // Then, status-update with final: true
    const statusUpdate: TaskStatusUpdate = {
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: {
        state: "completed",
        timestamp: new Date().toISOString(),
      },
      final: true,
    };
    envelopes.push(
      makeEnvelope({
        kind: "status-update",
        correlationId: ctx.correlationId,
        from: ctx.from,
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        payload: statusUpdate,
      })
    );

    return envelopes;
  }

  // Handle result with error subtypes
  if (
    m.type === "result" &&
    m.subtype &&
    m.subtype !== "success"
  ) {
    const statusUpdate: TaskStatusUpdate = {
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: {
        state: "failed",
        timestamp: new Date().toISOString(),
      },
      final: true,
    };
    return [
      makeEnvelope({
        kind: "status-update",
        correlationId: ctx.correlationId,
        from: ctx.from,
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        payload: {
          ...statusUpdate,
          metadata: { reason: m.subtype },
        } as any,
      }),
    ];
  }

  // Unknown message type
  return [];
}
