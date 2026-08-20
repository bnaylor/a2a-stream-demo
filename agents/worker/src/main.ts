import { query } from "@anthropic-ai/claude-agent-sdk";
import { fetchTaskRequest } from "@a2a-demo/protocol";
import { connectBus } from "@a2a-demo/agents-common";
import { runWorker } from "./run.ts";
import { randomUUID } from "node:crypto";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) { console.error(`${k} is required`); process.exit(1); }
  return v;
};

const taskId = need("TASK_ID");
const session = need("SESSION");
const natsUrl = need("NATS_URL");
need("ANTHROPIC_API_KEY"); // fail fast (spec §5)
const correlationId = process.env.CORRELATION_ID ?? `corr-${randomUUID()}`;
const contextId = process.env.CONTEXT_ID ?? `ctx-${randomUUID()}`;

const identity = { agentType: "claude-code", owner: "bnaylor", session, instanceId: randomUUID() };
const bus = await connectBus({ natsUrl, identity, description: `worker for ${taskId}` });
const ctx = { taskId, contextId, correlationId, from: { session, agentType: "claude-code" } };

const code = await runWorker({
  fetchTask: () => fetchTaskRequest(bus.nc, taskId),
  publishEvent: (env) => bus.publishEvent(taskId, env),
  queryStream: (prompt) => query({
    prompt,
    options: {
      model: process.env.WORKER_MODEL ?? "claude-haiku-4-5",
      permissionMode: "dontAsk",
      includePartialMessages: true,
      disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit"],
      maxTurns: 20,
      maxBudgetUsd: Number(process.env.WORKER_MAX_BUDGET_USD ?? "0.50"),
    },
  }) as AsyncIterable<never>,
  ctx,
});
await bus.close();
process.exit(code);
