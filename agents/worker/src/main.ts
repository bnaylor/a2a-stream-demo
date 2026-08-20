import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchTaskRequest } from "@a2a-demo/protocol";
import { connectBus, missingModelAuthEnv } from "@a2a-demo/agents-common";
import { runWorker } from "./run.ts";
import { makeProgressPublisher } from "./progress.ts";
import { randomUUID } from "node:crypto";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) { console.error(`${k} is required`); process.exit(1); }
  return v;
};

// Fail fast on model credentials (spec §5): an API key, or a complete Vertex
// config when CLAUDE_CODE_USE_VERTEX=1 (the GKE overlay's path).
const missingAuth = missingModelAuthEnv(process.env);
if (missingAuth.length > 0) {
  for (const k of missingAuth) console.error(`${k} is required`);
  process.exit(1);
}

const taskId = need("TASK_ID");
const session = need("SESSION");
const natsUrl = need("NATS_URL");
const correlationId = process.env.CORRELATION_ID ?? `corr-${randomUUID()}`;
const contextId = process.env.CONTEXT_ID ?? `ctx-${randomUUID()}`;
const WORK_DIR = "/work";

const identity = { agentType: "claude-code", owner: "bnaylor", session, instanceId: randomUUID() };
const bus = await connectBus({ natsUrl, identity, description: `worker for ${taskId}` });
const ctx = { taskId, contextId, correlationId, from: { session, agentType: "claude-code" } };

const reportProgress = makeProgressPublisher((env) => bus.publishEvent(taskId, env), ctx);

const mcp = createSdkMcpServer({
  name: "a2a",
  tools: [
    tool(
      "report_progress",
      "Report a progress milestone to the delegator; call at start, after each major step, and before finishing.",
      { message: z.string().describe("One short line describing what you just did or are about to do.") },
      async ({ message }) => {
        await reportProgress(message);
        return { content: [{ type: "text" as const, text: "progress reported" }] };
      }
    ),
  ],
});

const SYSTEM_PROMPT =
  `You are worker session ${session} executing one delegated task. ` +
  `Use mcp__a2a__report_progress at milestones: when starting, after each major ` +
  `step, and before your final answer. Your scratch directory is ${WORK_DIR}. ` +
  `Work autonomously; your final message is the deliverable.`;

const code = await runWorker({
  fetchTask: () => fetchTaskRequest(bus.nc, taskId),
  publishEvent: (env) => bus.publishEvent(taskId, env),
  queryStream: (prompt) => query({
    prompt,
    options: {
      model: process.env.WORKER_MODEL ?? "claude-haiku-4-5",
      cwd: WORK_DIR,
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "dontAsk",
      includePartialMessages: true,
      mcpServers: { a2a: mcp },
      // Explicit allowlist. Write is deliberately permitted so research tasks
      // can draft into the pod's own emptyDir scratch at /work (cwd); the pod
      // has no service account and nothing at /work outlives it. Bash, Edit and
      // NotebookEdit stay denied.
      allowedTools: [
        "mcp__a2a__report_progress",
        "WebSearch",
        "WebFetch",
        "Read",
        "Write",
        "Glob",
        "Grep",
        "TodoWrite",
      ],
      disallowedTools: ["Bash", "Edit", "NotebookEdit"],
      maxTurns: 20,
      maxBudgetUsd: Number(process.env.WORKER_MAX_BUDGET_USD ?? "1.50"),
    },
  }) as AsyncIterable<never>,
  ctx,
});
await bus.close();
process.exit(code);
