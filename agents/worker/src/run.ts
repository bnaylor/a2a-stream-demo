import { Envelope, makeEnvelope } from "@a2a-demo/protocol";
import { SdkMsg, TaskCtx, mapSdkMessage } from "@a2a-demo/agents-common";

export interface WorkerDeps {
  fetchTask(): Promise<Envelope | null>;
  publishEvent(env: Envelope): Promise<void>;
  queryStream(prompt: string): AsyncIterable<SdkMsg>;
  ctx: TaskCtx;
}

function status(ctx: TaskCtx, state: "working" | "failed", final: boolean, reason?: string): Envelope {
  return makeEnvelope({
    kind: "status-update", correlationId: ctx.correlationId,
    taskId: ctx.taskId, contextId: ctx.contextId, from: ctx.from,
    payload: { taskId: ctx.taskId, contextId: ctx.contextId, final,
      status: { state, timestamp: new Date().toISOString() },
      ...(reason ? { metadata: { reason } } : {}) },
  });
}

export async function runWorker(deps: WorkerDeps): Promise<number> {
  const task = await deps.fetchTask();
  if (!task) {
    await deps.publishEvent(status(deps.ctx, "failed", true, "task-not-found"));
    return 1;
  }
  const prompt = (task.payload as { prompt?: string }).prompt ?? "";
  await deps.publishEvent(status(deps.ctx, "working", false));
  try {
    let sawFinal = false;
    for await (const m of deps.queryStream(prompt)) {
      for (const env of mapSdkMessage(m as SdkMsg, deps.ctx)) {
        await deps.publishEvent(env);
        if (env.kind === "status-update" &&
            (env.payload as { final?: boolean }).final) sawFinal = true;
      }
    }
    if (!sawFinal) {
      await deps.publishEvent(status(deps.ctx, "failed", true, "stream-ended-without-result"));
      return 1;
    }
    return 0;
  } catch (err) {
    await deps.publishEvent(status(deps.ctx, "failed", true, String(err)));
    return 1;
  }
}
