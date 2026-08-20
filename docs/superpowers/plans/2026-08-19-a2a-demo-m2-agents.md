# A2A Demo M2 — Real Agents In-Cluster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ChatOps and worker agents — real Claude Agent SDK sessions in pods — delegating over the M1 protocol: chat turn in, worker pod spawned, events streamed, status answered by replay, pod GC'd.

**Architecture:** Both agents embed the Claude Agent SDK headless (`permissionMode: "dontAsk"`, custom in-process MCP tools only for ChatOps). A shared `agents/common` package maps SDK stream events onto `a2a-jetstream` envelopes. ChatOps holds one persistent session (captured `session_id` + `resume`), receives chat turns as A2A tasks addressed via a new optional envelope `to` field, and creates worker pods through the k8s API. Workers are one-shot: fetch task → `query()` → stream events → artifact → `completed` → exit.

**Tech Stack:** Node 22 / TypeScript (existing workspace), `@anthropic-ai/claude-agent-sdk` + `zod`, `@kubernetes/client-node`, `nats` (already). Images: `node:22-slim`, non-root.

**Spec:** `docs/superpowers/specs/2026-08-19-a2a-jetstream-demo-design.md` §4 (components), §5 (error handling); wire contract `protocol/SPEC.md`.

## Global Constraints

- Everything runs as before in namespace `a2a-demo`; no cluster-scoped resources beyond the Namespace; NEVER `kubectl apply` from the laptop (GKE context hazard — render-only verification).
- Images built/pushed by rune to `10.3.10.52:5000/a2a-demo/{chatops,worker}:latest`; Dockerfiles live in this repo.
- Model selection is env-driven, **defaults: ChatOps `claude-sonnet-5`, workers `claude-haiku-4-5`** (billing is bnaylor's personal API key — flag any change of default to bnaylor). Env: `CHATOPS_MODEL`, `WORKER_MODEL`.
- Worker budget caps: `maxBudgetUsd` from env `WORKER_MAX_BUDGET_USD` (default `0.50`), `maxTurns` 20.
- Headless SDK rules (verified against code.claude.com/docs/en/agent-sdk, 2026-08): `permissionMode: "dontAsk"` (NOT `bypassPermissions` — refuses to run as root and we run non-root anyway), `includePartialMessages: true` for stream deltas, custom tools named `mcp__a2a__<tool>`, SDK bundles the `claude` binary (no separate install), containers need writable `HOME` and `CLAUDE_CONFIG_DIR`, set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- ChatOps RBAC stays exactly: pods create/get/list/watch/delete + pods/log get, namespace-scoped (already deployed).
- Workers get no k8s API (`automountServiceAccountToken: false`) and SDK tools limited to `WebSearch` + read-only (`disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit"]`).
- Protocol change in this milestone: envelope gains OPTIONAL `to?: {session}` (additive; consumers already ignore unknown fields). Task-scoped semantics unchanged. SPEC.md must be updated in the same task that adds the field.
- All unit tests run without NATS or API keys (inject fakes); integration tests remain `NATS_URL`-gated; nothing in CI/tests ever calls the real Anthropic API.
- Every new package: TypeScript strict, vitest, `"./file.ts"` import style (tsconfig already allows it).
- `@kubernetes/client-node` and `@anthropic-ai/claude-agent-sdk` API surfaces evolve: if an installed version's call signature differs from the plan's code, adapt INSIDE the file, keep the exported signatures exactly as specified, and record the deviation in the task report.

---

### Task 1: Protocol additions — `to` field, AgentCard type, task submission/watch helpers

**Files:**
- Modify: `protocol/src/envelope.ts`, `protocol/src/types.ts`, `protocol/src/client.ts`, `protocol/src/index.ts`, `protocol/SPEC.md`
- Test: `protocol/src/envelope.test.ts` (extend), `protocol/src/client.test.ts` (extend)

**Interfaces:**
- Consumes: M1 protocol lib.
- Produces: `Envelope.to?: {session: string}`; `MakeEnvelopeInput.to?`; type `AgentCard {session, agentType, owner, startedAt, description?}`; `submitTask(nc, env): Promise<void>` (publishes to the request subject derived from `env.taskId`); `fetchTaskRequest(nc, taskId): Promise<Envelope | null>` (cold read of the single request message); `watchTaskRequests(nc, session, onEnvelope): Promise<() => void>` (live ordered consumer on `a2a.tasks.*.request`, deliver **new** only, invoking callback only when `env.to?.session === session`).

- [ ] **Step 1: Write the failing tests**

Append to `protocol/src/envelope.test.ts`:

```ts
it("round-trips the optional to field", () => {
  const env = makeEnvelope({
    kind: "task", correlationId: "corr-1", taskId: "task-1", contextId: "ctx-1",
    from, to: { session: "chatops" },
    payload: { id: "task-1", contextId: "ctx-1", status: { state: "submitted", timestamp: "2026-08-19T21:00:00Z" } },
  });
  expect(parseEnvelope(encodeEnvelope(env)).to).toEqual({ session: "chatops" });
});

it("omits to when absent and tolerates malformed to", () => {
  const env = makeEnvelope({ kind: "agent-card", correlationId: "c", from, payload: {} });
  expect(env.to).toBeUndefined();
  const raw = JSON.stringify({ ...JSON.parse(new TextDecoder().decode(encodeEnvelope(env))), to: "junk" });
  expect(parseEnvelope(raw).to).toBeUndefined(); // non-object to is dropped, not fatal
});
```

Append to the gated suite in `protocol/src/client.test.ts`:

```ts
it("submitTask + fetchTaskRequest + watchTaskRequests round-trip", async () => {
  const nc = await connect({ servers: url });
  try {
    await ensureStream(await nc.jetstreamManager());
    const taskId = newTaskId();
    const seen: Envelope[] = [];
    const stop = await watchTaskRequests(nc, "chatops", (e) => seen.push(e));

    const env = makeEnvelope({
      kind: "task", correlationId: "corr-w", taskId, contextId: "ctx-w",
      from, to: { session: "chatops" },
      payload: { id: taskId, contextId: "ctx-w", status: { state: "submitted", timestamp: new Date().toISOString() } },
    });
    await submitTask(nc, env);

    // Addressed-elsewhere and unaddressed tasks are not delivered to the callback.
    const otherId = newTaskId();
    await submitTask(nc, makeEnvelope({
      kind: "task", correlationId: "corr-w2", taskId: otherId, contextId: "ctx-w",
      from, to: { session: "someone-else" },
      payload: { id: otherId, contextId: "ctx-w", status: { state: "submitted", timestamp: new Date().toISOString() } },
    }));

    await new Promise((r) => setTimeout(r, 500));
    stop();
    expect(seen.map((e) => e.taskId)).toEqual([taskId]);

    const fetched = await fetchTaskRequest(nc, taskId);
    expect(fetched?.correlationId).toBe("corr-w");
    expect(await fetchTaskRequest(nc, newTaskId())).toBeNull();
  } finally {
    await nc.close();
  }
}, 15_000);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run protocol/src/envelope.test.ts` → FAIL (`to` unknown). With a local `nats-server -js -p 4341` and `NATS_URL=nats://127.0.0.1:4341`: `npx vitest run protocol/src/client.test.ts` → FAIL (missing exports).

- [ ] **Step 3: Implement**

`protocol/src/envelope.ts` — add to the interfaces and codec:

```ts
export interface EnvelopeTo {
  session: string;
}
```

Then three concrete edits: (a) `Envelope` interface gains the member `to?: EnvelopeTo;` after `from`; (b) `MakeEnvelopeInput` gains `to?: EnvelopeTo;` and `makeEnvelope`'s returned object gains `to: input.to,`; (c) in `parseEnvelope`, before the `return`, add:

```ts
const toRaw = e.to as Record<string, unknown> | undefined;
const to = typeof toRaw?.session === "string" ? { session: toRaw.session } : undefined;
```

and include `to,` in the returned object.

`protocol/src/types.ts` — append:

```ts
export interface AgentCard {
  session: string;
  agentType: string;
  owner: string;
  startedAt: string; // ISO-8601
  description?: string;
}
```

`protocol/src/client.ts` — append:

```ts
export async function submitTask(nc: NatsConnection, env: Envelope): Promise<void> {
  if (env.kind !== "task" || !env.taskId) throw new Error("submitTask requires a task envelope with taskId");
  await publishEnvelope(nc, taskRequestSubject(env.taskId), env);
}

export async function fetchTaskRequest(nc: NatsConnection, taskId: string): Promise<Envelope | null> {
  const subject = taskRequestSubject(taskId);
  const jsm = await nc.jetstreamManager();
  try {
    const m = await jsm.streams.getMessage(STREAM_NAME, { last_by_subj: subject });
    return parseEnvelope(m.data);
  } catch {
    return null;
  }
}

export async function watchTaskRequests(
  nc: NatsConnection, session: string, onEnvelope: (env: Envelope) => void,
): Promise<() => void> {
  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.deliverNew();
  const sub = await nc.jetstream().subscribe("a2a.tasks.*.request", opts);
  (async () => {
    for await (const m of sub) {
      let env: Envelope;
      try {
        env = parseEnvelope(m.data);
      } catch {
        continue;
      }
      if (env.to?.session === session) onEnvelope(env);
    }
  })().catch(() => { /* subscription closed */ });
  return () => sub.unsubscribe();
}
```

(Imports to extend at top: `taskRequestSubject` from subjects.)

`protocol/SPEC.md` — in the Envelope section add the optional field with one sentence: `to?: {session}` addresses a task envelope to a named session; consumers watching the request wildcard MUST ignore envelopes addressed elsewhere. Bump nothing (additive).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run protocol/` (unit parts pass; gated parts with local nats-server as in Step 2) and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add protocol/
git commit -m "feat(m2): envelope to-addressing, AgentCard, submit/fetch/watch task helpers"
```

---

### Task 2: `agents/common` — bus bootstrap and SDK→A2A event mapper

**Files:**
- Create: `agents/common/package.json`, `agents/common/src/bus.ts`, `agents/common/src/mapper.ts`, `agents/common/src/index.ts`
- Test: `agents/common/src/mapper.test.ts`
- Modify: root `package.json` (workspaces gains `"agents/*"`), root `tsconfig.json` (include gains `"agents/*/src"`)

**Interfaces:**
- Consumes: `@a2a-demo/protocol` (everything), `nats`.
- Produces:
  - `connectBus(cfg: {natsUrl: string; identity: AgentIdentity; description?: string}): Promise<Bus>` where `Bus = { nc: NatsConnection; publishEvent(taskId: string, env: Envelope): Promise<void>; close(): Promise<void> }` — connects, `ensureStream`, publishes an `agent-card` envelope on `agentCardSubject(session)`, starts heartbeat; `close()` publishes `agent-closed`, stops heartbeat, drains.
  - `mapSdkMessage(m: SdkMsg, ctx: TaskCtx): Envelope[]` — pure function; `SdkMsg` is a minimal structural type (see below) so tests need no SDK import; `TaskCtx = {taskId, contextId, correlationId, from: EnvelopeFrom}`.

Mapping rules (the demo's core translation — spec §4.2):

| SDK message | A2A envelope(s) |
|---|---|
| `stream_event` with `content_block_delta`/`text_delta` | `message-chunk` (payload: A2AMessage, role "agent", single text part with the delta) |
| `stream_event` with `content_block_delta`/`thinking_delta` | `message-chunk` with part text prefixed `"[thinking] "` |
| `assistant` message containing `tool_use` blocks | one `status-update` per tool_use, state `working`, `final: false`, payload metadata `{tool: name}` |
| `result` subtype `success` | `artifact-update` (payload: Artifact, one text part = `message.result`) THEN `status-update` state `completed`, `final: true` |
| `result` any error subtype | `status-update` state `failed`, `final: true`, payload metadata `{reason: subtype}` |
| anything else | `[]` |

- [ ] **Step 1: Write the failing test**

`agents/common/src/mapper.test.ts` — cover every row above with literal fake messages, e.g.:

```ts
import { describe, expect, it } from "vitest";
import { mapSdkMessage } from "./mapper.ts";

const ctx = { taskId: "task-1", contextId: "ctx-1", correlationId: "corr-1",
  from: { session: "worker-brisk-otter", agentType: "claude-code" } };

describe("mapSdkMessage", () => {
  it("maps text deltas to message-chunk", () => {
    const out = mapSdkMessage({ type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("message-chunk");
    expect(out[0].correlationId).toBe("corr-1");
  });
  it("prefixes thinking deltas", () => {
    const out = mapSdkMessage({ type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }, ctx);
    expect((out[0].payload as { parts: { text: string }[] }).parts[0].text).toBe("[thinking] hmm");
  });
  it("maps tool_use to working status with tool metadata", () => {
    const out = mapSdkMessage({ type: "assistant",
      message: { content: [{ type: "tool_use", name: "WebSearch" }, { type: "text", text: "x" }] } }, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("status-update");
  });
  it("maps success result to artifact then final completed", () => {
    const out = mapSdkMessage({ type: "result", subtype: "success", result: "42" }, ctx);
    expect(out.map((e) => e.kind)).toEqual(["artifact-update", "status-update"]);
  });
  it("maps error results to final failed", () => {
    const out = mapSdkMessage({ type: "result", subtype: "error_max_turns" }, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("status-update");
  });
  it("ignores unknown messages", () => {
    expect(mapSdkMessage({ type: "system", subtype: "init" }, ctx)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run agents/common` → FAIL (module missing). (Run `npm install` after editing workspaces so the workspace resolves.)

- [ ] **Step 3: Implement**

`agents/common/package.json`:

```json
{
  "name": "@a2a-demo/agents-common",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@a2a-demo/protocol": "*",
    "nats": "^2.29.0"
  }
}
```

`agents/common/src/mapper.ts` (structural `SdkMsg` type — `{type: string; subtype?: string; result?: string; event?: {type: string; delta?: {type: string; text?: string; thinking?: string}}; message?: {content: {type: string; name?: string; text?: string}[]}}` — plus the table above implemented with `makeEnvelope`; status timestamps `new Date().toISOString()`; artifact ids `artifact-<taskId>`; message ids via `newTaskId()` is WRONG — add `newMessageId()`? No: use `crypto.randomUUID()` inline with prefix `msg-`).

`agents/common/src/bus.ts`:

```ts
import { connect, NatsConnection } from "nats";
import {
  AgentIdentity, Envelope, ensureStream, makeEnvelope, newCorrelationId,
  publishEnvelope, agentCardSubject, startHeartbeat, taskEventsSubject,
} from "@a2a-demo/protocol";

export interface Bus {
  nc: NatsConnection;
  publishEvent(taskId: string, env: Envelope): Promise<void>;
  close(): Promise<void>;
}

export async function connectBus(cfg: {
  natsUrl: string; identity: AgentIdentity; description?: string;
}): Promise<Bus> {
  const nc = await connect({ servers: cfg.natsUrl });
  await ensureStream(await nc.jetstreamManager());
  const from = { session: cfg.identity.session, agentType: cfg.identity.agentType };
  const cardCorr = newCorrelationId();
  await publishEnvelope(nc, agentCardSubject(cfg.identity.session), makeEnvelope({
    kind: "agent-card", correlationId: cardCorr, from,
    payload: {
      session: cfg.identity.session, agentType: cfg.identity.agentType,
      owner: cfg.identity.owner, startedAt: new Date().toISOString(),
      description: cfg.description,
    },
  }));
  const stopHb = startHeartbeat(nc, cfg.identity);
  return {
    nc,
    publishEvent: (taskId, env) => publishEnvelope(nc, taskEventsSubject(taskId), env),
    close: async () => {
      stopHb();
      await publishEnvelope(nc, agentCardSubject(cfg.identity.session), makeEnvelope({
        kind: "agent-closed", correlationId: cardCorr, from, payload: { session: cfg.identity.session },
      }));
      await nc.drain();
    },
  };
}
```

`agents/common/src/index.ts` re-exports both files.

- [ ] **Step 4: Verify** — `npx vitest run agents/common && npm run typecheck` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json agents/common/
git commit -m "feat(m2): agents-common bus bootstrap and SDK-to-A2A event mapper"
```

---

### Task 3: Worker agent

**Files:**
- Create: `agents/worker/package.json`, `agents/worker/src/run.ts`, `agents/worker/src/main.ts`
- Test: `agents/worker/src/run.test.ts`

**Interfaces:**
- Consumes: `connectBus`, `mapSdkMessage` (Task 2); `fetchTaskRequest` (Task 1).
- Produces: `runWorker(deps: WorkerDeps): Promise<number>` (exit code; pure orchestration, all I/O injected) and a `main.ts` entrypoint wiring real deps. `WorkerDeps = { fetchTask(): Promise<Envelope | null>; publishEvent(env: Envelope): Promise<void>; queryStream(prompt: string): AsyncIterable<SdkMsg>; ctx: TaskCtx }`.

`agents/worker/package.json` adds `"@anthropic-ai/claude-agent-sdk": "^0.3.0"` and `"@a2a-demo/agents-common": "*"` (adapt the SDK semver to the current published version at implementation time; record the exact version in the report).

- [ ] **Step 1: Write the failing test**

`agents/worker/src/run.test.ts` — inject fakes, no NATS/SDK:

```ts
import { describe, expect, it } from "vitest";
import { runWorker } from "./run.ts";
import { makeEnvelope, Envelope } from "@a2a-demo/protocol";

const ctx = { taskId: "task-1", contextId: "ctx-1", correlationId: "corr-1",
  from: { session: "worker-x", agentType: "claude-code" } };

const taskEnv = makeEnvelope({
  kind: "task", correlationId: "corr-1", taskId: "task-1", contextId: "ctx-1",
  from: { session: "chatops", agentType: "claude-code" },
  payload: { id: "task-1", contextId: "ctx-1",
    status: { state: "submitted", timestamp: "2026-08-19T21:00:00Z" },
    prompt: "count to three" },
});

async function* fakeStream() {
  yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "1 2 3" } } };
  yield { type: "result", subtype: "success", result: "1 2 3" };
}

describe("runWorker", () => {
  it("publishes working, streams events, ends completed, exits 0", async () => {
    const published: Envelope[] = [];
    const code = await runWorker({
      fetchTask: async () => taskEnv,
      publishEvent: async (e) => { published.push(e); },
      queryStream: () => fakeStream(),
      ctx,
    });
    expect(code).toBe(0);
    expect(published[0].kind).toBe("status-update"); // working
    expect(published.map((e) => e.kind)).toEqual(
      ["status-update", "message-chunk", "artifact-update", "status-update"]);
    expect(published.every((e) => e.correlationId === "corr-1")).toBe(true);
  });

  it("exits 1 and publishes failed when the task is missing", async () => {
    const published: Envelope[] = [];
    const code = await runWorker({
      fetchTask: async () => null,
      publishEvent: async (e) => { published.push(e); },
      queryStream: () => fakeStream(),
      ctx,
    });
    expect(code).toBe(1);
    expect(published.at(-1)?.kind).toBe("status-update"); // failed, final
  });

  it("publishes failed and exits 1 when the stream throws", async () => {
    async function* broken(): AsyncIterable<never> { throw new Error("api down"); }
    const published: Envelope[] = [];
    const code = await runWorker({
      fetchTask: async () => taskEnv,
      publishEvent: async (e) => { published.push(e); },
      queryStream: () => broken(),
      ctx,
    });
    expect(code).toBe(1);
    expect(published.at(-1)?.kind).toBe("status-update");
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run agents/worker` → FAIL (module missing).

- [ ] **Step 3: Implement**

`agents/worker/src/run.ts`:

```ts
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
```

`agents/worker/src/main.ts` (real wiring; not unit-tested — exercised in-cluster):

```ts
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
```

`agents/worker/package.json` mirrors common's shape with the two extra deps.

- [ ] **Step 4: Verify** — `npx vitest run agents/worker && npm run typecheck` → PASS/clean. (The `as AsyncIterable<never>` cast bridges SDK types to the structural `SdkMsg`; if the installed SDK exports a usable message union, prefer a proper cast and note it.)

- [ ] **Step 5: Commit**

```bash
git add agents/worker/ package-lock.json
git commit -m "feat(m2): worker agent — one-shot SDK run mapped onto A2A events"
```

---

### Task 4: ChatOps agent

**Files:**
- Create: `agents/chatops/package.json`, `agents/chatops/src/k8s.ts`, `agents/chatops/src/session.ts`, `agents/chatops/src/chatops.ts`, `agents/chatops/src/main.ts`
- Test: `agents/chatops/src/chatops.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers (`watchTaskRequests`, `submitTask`, `replayTaskEvents`), Task 2 (`connectBus`, `mapSdkMessage`).
- Produces:
  - `k8s.ts`: `PodManager` interface `{ createWorkerPod(spec: WorkerPodSpec): Promise<void>; listWorkerPods(): Promise<{name: string; session: string; phase: string}[]>; deletePod(name: string): Promise<void> }` with `WorkerPodSpec = {session, taskId, correlationId, contextId}`; `makeK8sPodManager(cfg: {namespace, image, natsUrl, secretName}): PodManager` using `@kubernetes/client-node` (in-cluster config). Pod shape mirrors `pre-gke/worker-reference.yaml`: labels `app: a2a-worker`, `a2a-demo/session: <session>`, `restartPolicy: Never`, `automountServiceAccountToken: false`, env TASK_ID/SESSION/NATS_URL/CORRELATION_ID/CONTEXT_ID + secretKeyRef ANTHROPIC_API_KEY + WORKER_MODEL passthrough, resources 250m/512Mi requests, 1 CPU/2Gi limits.
  - `session.ts`: `ChatSession` interface `{ send(prompt: string): AsyncIterable<SdkMsg> }`; `makeSdkChatSession(model: string): ChatSession` — wraps `query()` capturing `session_id` from the `system/init` message and passing `resume: sessionId` on subsequent sends (persistent conversation).
  - `chatops.ts`: `startChatOps(deps: ChatOpsDeps): Promise<() => Promise<void>>` — the orchestrator, fully injectable: `ChatOpsDeps = { session: ChatSession; pods: PodManager; watchInbox(cb): Promise<() => void>; publishEvent(taskId, env): Promise<void>; submitTask(env): Promise<void>; replayEvents(taskId): Promise<Envelope[]>; subscribeEvents(taskId, cb): Promise<() => void>; newSessionName(): string; newIds(): {taskId, contextId}; ownSession: string }`.

**ChatOps behavior (the plan's contract, tested via fakes):**
1. On inbox task (a chat turn addressed `to: chatops`): drain any pending delegate notices into the prompt (`"[notice] session X completed: <first 500 chars of artifact>"` lines prepended), run `session.send(prompt)`, map SDK messages via `mapSdkMessage` with the CHAT task's ctx, publish onto the chat task's events subject. Custom tools fire during the send (below).
2. `delegate_task(prompt)` tool handler (wired in `main.ts` via `createSdkMcpServer`, but the LOGIC lives in a `deps`-level function `delegate(prompt): Promise<{taskId, session}>` so it's testable): mint session name + ids, `pods.createWorkerPod`, `submitTask` (task envelope, `from: chatops`, prompt in payload, same correlationId as the current chat turn), `subscribeEvents(taskId)` to collect the terminal event into `pendingNotices` and trigger pod GC (delete after terminal status, then publish nothing extra — worker publishes its own `agent-closed` via bus.close()).
3. `task_status(taskId)` logic function: `replayEvents(taskId)` → return a compact text digest (kind + state + first 120 chars of any text part per event, max last 30 events) for Claude to summarize.
4. `list_sessions()` logic function: `pods.listWorkerPods()` formatted as text.
5. **Crash sweep (spec §5):** `sweepOnce()` on the returned handle (called by `main.ts` on a 60 s interval): for each worker pod with phase `Failed` or `Succeeded`, replay its task's events (session→taskId tracked from delegation); if no terminal (`final: true`) status exists, publish a synthetic `status-update` state `failed` (`from: chatops`, metadata `{reason: "pod-" + phase.toLowerCase() + "-without-final-event"}`), then delete the pod either way.

- [ ] **Step 1: Write the failing test**

`agents/chatops/src/chatops.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { startChatOps, ChatOpsDeps } from "./chatops.ts";
import { Envelope, makeEnvelope } from "@a2a-demo/protocol";

type Published = { taskId: string; env: Envelope };

function makeFakes() {
  const published: Published[] = [];
  const submitted: Envelope[] = [];
  const created: { session: string; taskId: string }[] = [];
  const deleted: string[] = [];
  const prompts: string[] = [];
  const eventSubs = new Map<string, (env: Envelope) => void>();
  let inbox: ((env: Envelope) => void) | undefined;
  let pods: { name: string; session: string; phase: string }[] = [];
  let replay: Envelope[] = [];

  async function* okStream() {
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } };
    yield { type: "result", subtype: "success", result: "ok" };
  }

  const deps: ChatOpsDeps = {
    session: { send: (p) => { prompts.push(p); return okStream(); } },
    pods: {
      createWorkerPod: async (s) => { created.push({ session: s.session, taskId: s.taskId }); },
      listWorkerPods: async () => pods,
      deletePod: async (n) => { deleted.push(n); },
    },
    watchInbox: async (cb) => { inbox = cb; return () => {}; },
    publishEvent: async (taskId, env) => { published.push({ taskId, env }); },
    submitTask: async (env) => { submitted.push(env); },
    replayEvents: async () => replay,
    subscribeEvents: async (taskId, cb) => { eventSubs.set(taskId, cb); return () => {}; },
    newSessionName: () => "worker-test-otter",
    newIds: () => ({ taskId: "task-d1", contextId: "ctx-d1" }),
    ownSession: "chatops",
  };
  const chatTurn = (id: string, prompt: string) => makeEnvelope({
    kind: "task", correlationId: `corr-${id}`, taskId: id, contextId: `ctx-${id}`,
    from: { session: "web", agentType: "browser" }, to: { session: "chatops" },
    payload: { id, contextId: `ctx-${id}`, prompt,
      status: { state: "submitted", timestamp: "2026-08-19T21:00:00Z" } },
  });
  return { deps, published, submitted, created, deleted, prompts, eventSubs,
    sendInbox: (e: Envelope) => inbox!(e), chatTurn,
    setPods: (p: typeof pods) => { pods = p; }, setReplay: (r: Envelope[]) => { replay = r; } };
}

const terminal = (taskId: string, state: "completed" | "failed") => makeEnvelope({
  kind: "status-update", correlationId: "corr-x", taskId, contextId: "ctx-x",
  from: { session: "worker-test-otter", agentType: "claude-code" },
  payload: { taskId, contextId: "ctx-x", final: true,
    status: { state, timestamp: "2026-08-19T21:05:00Z" } },
});

describe("startChatOps", () => {
  it("answers a chat turn with events ending in final completed", async () => {
    const f = makeFakes();
    await startChatOps(f.deps);
    f.sendInbox(f.chatTurn("task-c1", "hello"));
    await new Promise((r) => setTimeout(r, 20));
    const kinds = f.published.filter((p) => p.taskId === "task-c1").map((p) => p.env.kind);
    expect(kinds[0]).toBe("status-update"); // working
    expect(kinds).toContain("message-chunk");
    expect(kinds.at(-1)).toBe("status-update"); // completed final
  });

  it("delegates: creates pod, submits unaddressed task, preserves correlationId", async () => {
    const f = makeFakes();
    const handle = await startChatOps(f.deps);
    f.sendInbox(f.chatTurn("task-c2", "delegate something"));
    await new Promise((r) => setTimeout(r, 20));
    const res = await handle.delegate("write a haiku");
    expect(res).toEqual({ taskId: "task-d1", session: "worker-test-otter" });
    expect(f.created).toEqual([{ session: "worker-test-otter", taskId: "task-d1" }]);
    expect(f.submitted[0].kind).toBe("task");
    expect(f.submitted[0].to).toBeUndefined();
    expect(f.submitted[0].correlationId).toBe("corr-task-c2"); // current chat turn's corr
    expect((f.submitted[0].payload as { prompt: string }).prompt).toBe("write a haiku");
  });

  it("weaves delegate completion into the next turn and GCs the pod", async () => {
    const f = makeFakes();
    const handle = await startChatOps(f.deps);
    f.sendInbox(f.chatTurn("task-c3", "delegate"));
    await new Promise((r) => setTimeout(r, 20));
    await handle.delegate("job");
    f.setPods([{ name: "a2a-worker-test-otter", session: "worker-test-otter", phase: "Succeeded" }]);
    f.eventSubs.get("task-d1")!(terminal("task-d1", "completed"));
    await new Promise((r) => setTimeout(r, 20));
    expect(f.deleted).toEqual(["a2a-worker-test-otter"]);
    f.sendInbox(f.chatTurn("task-c4", "anything new?"));
    await new Promise((r) => setTimeout(r, 20));
    expect(f.prompts.at(-1)).toMatch(/\[notice\][\s\S]*worker-test-otter/);
  });

  it("task_status digest reflects replayed states", async () => {
    const f = makeFakes();
    const handle = await startChatOps(f.deps);
    f.setReplay([terminal("task-z", "completed")]);
    expect(await handle.taskStatus("task-z")).toMatch(/completed/);
  });

  it("sweep publishes synthetic failed for a dead pod with no final event", async () => {
    const f = makeFakes();
    const handle = await startChatOps(f.deps);
    f.sendInbox(f.chatTurn("task-c5", "delegate"));
    await new Promise((r) => setTimeout(r, 20));
    await handle.delegate("job");
    f.setPods([{ name: "a2a-worker-test-otter", session: "worker-test-otter", phase: "Failed" }]);
    f.setReplay([]); // no terminal event ever published
    await handle.sweepOnce();
    const synthetic = f.published.find((p) => p.taskId === "task-d1");
    expect(synthetic?.env.kind).toBe("status-update");
    expect((synthetic?.env.payload as { status: { state: string } }).status.state).toBe("failed");
    expect(f.deleted).toContain("a2a-worker-test-otter");
  });
});
```

The returned handle from `startChatOps` is therefore `{ delegate(prompt): Promise<{taskId, session}>; taskStatus(id): Promise<string>; listSessions(): Promise<string>; sweepOnce(): Promise<void>; stop(): Promise<void> }` — `main.ts` binds the first three to the MCP tools and calls `sweepOnce` on an interval.

- [ ] **Step 2: Verify failure** — `npx vitest run agents/chatops` → FAIL.

- [ ] **Step 3: Implement** `chatops.ts` orchestration exactly per the behavior contract; `k8s.ts` with `@kubernetes/client-node` (`KubeConfig.loadFromCluster()`, `CoreV1Api`; adapt to installed major version inside this file only); `session.ts` per the SDK reference (`query({prompt, options: {model, resume: sessionId, permissionMode: "dontAsk", includePartialMessages: true, mcpServers, allowedTools: ["mcp__a2a__*"], disallowedTools: ["Write","Edit","Bash","NotebookEdit","WebSearch","Read","Glob","Grep"], systemPrompt}})`; capture `session_id` from `system`/`init`); `main.ts` wires: env (NATS_URL, ANTHROPIC_API_KEY fail-fast, CHATOPS_MODEL default `claude-sonnet-5`, NAMESPACE default `a2a-demo`, WORKER_IMAGE required, SECRET_NAME default `a2a-demo-secrets`), `connectBus` (session `chatops`), `createSdkMcpServer({name: "a2a", tools: [delegate_task, task_status, list_sessions]})` with zod schemas, tools calling the logic functions from `startChatOps`'s returned handle, `watchTaskRequests(nc, "chatops", ...)` as inbox, SIGTERM → `bus.close()`.

ChatOps systemPrompt (verbatim in `main.ts`):

```
You are ChatOps, the delegation gateway for an agent cluster. For any request that
needs multi-step work, use mcp__a2a__delegate_task to hand it to a worker session and
tell the user the session name. Answer status questions with mcp__a2a__task_status /
mcp__a2a__list_sessions and summarize the raw events in plain language. Prefix any
relayed delegate output with its session name in brackets. Keep responses concise.
```

- [ ] **Step 4: Verify** — `npx vitest run agents/chatops && npm run typecheck` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add agents/chatops/ package-lock.json
git commit -m "feat(m2): chatops agent — persistent session, delegation tools, pod lifecycle"
```

---

### Task 5: Dockerfiles

**Files:**
- Create: `agents/Dockerfile` (one file, two targets), `.dockerignore`

**Interfaces:**
- Consumes: the workspace layout; Produces: images `chatops` and `worker` rune builds as `docker build --target chatops -t 10.3.10.52:5000/a2a-demo/chatops:latest -f agents/Dockerfile .` (context = repo root) and the same with `--target worker`.

- [ ] **Step 1: Write `agents/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY protocol/package.json protocol/
COPY agents/common/package.json agents/common/
COPY agents/worker/package.json agents/worker/
COPY agents/chatops/package.json agents/chatops/
RUN npm ci --omit=dev && npm install -g tsx@4
COPY protocol/ protocol/
COPY agents/ agents/
# Non-root: the Agent SDK needs a writable HOME and config dir.
RUN useradd -m -u 1000 agent && mkdir -p /home/agent/.claude && chown -R agent /home/agent /app
USER agent
ENV HOME=/home/agent CLAUDE_CONFIG_DIR=/home/agent/.claude CLAUDE_CODE_DISABLE_AUTO_MEMORY=1

FROM base AS worker
CMD ["tsx", "agents/worker/src/main.ts"]

FROM base AS chatops
CMD ["tsx", "agents/chatops/src/main.ts"]
```

`.dockerignore`:

```
node_modules
.git
.claude
.superpowers
docs
pre-gke
web
scripts
*.md
```

Note: `npm ci --omit=dev` must still install `tsx`? No — tsx is installed globally in the same layer, deliberately outside the workspace dev deps. Vitest/typescript are NOT in the image.

- [ ] **Step 2: Verify what's verifiable locally** — no docker on this laptop: `node -e "require('fs').accessSync('agents/Dockerfile')"` plus a careful re-read against the workspace paths. Rune verifies the actual build (Task 7 handoff).

- [ ] **Step 3: Commit**

```bash
git add agents/Dockerfile .dockerignore
git commit -m "feat(m2): multi-target Dockerfile for chatops and worker images"
```

---

### Task 6: Manifest updates

**Files:**
- Modify: `pre-gke/chatops-deploy.yaml` (env: add CHATOPS_MODEL default omitted → set explicitly `claude-sonnet-5`, WORKER_IMAGE `10.3.10.52:5000/a2a-demo/worker:latest`, WORKER_MODEL `claude-haiku-4-5`, NAMESPACE via fieldRef `metadata.namespace`; resources: requests 250m/512Mi, limits 1 CPU/2Gi; add `securityContext: {runAsNonRoot: true, runAsUser: 1000}` at pod level)
- Modify: `pre-gke/worker-reference.yaml` (align env names with Task 3's contract: TASK_ID, SESSION, NATS_URL, CORRELATION_ID, CONTEXT_ID, WORKER_MODEL, WORKER_MAX_BUDGET_USD, ANTHROPIC_API_KEY secretKeyRef; same securityContext; resources 250m/512Mi → 1 CPU/2Gi; note reminding that chatops creates these programmatically — keep `k8s.ts` and this file in sync)

**Interfaces:** consumes Task 4's env contract; produces manifests rune applies.

- [ ] **Step 1: Edit both files** per above (keep every existing comment that still applies).
- [ ] **Step 2: Verify render** — `kubectl kustomize pre-gke/ > /dev/null && echo OK` (render ONLY — never apply from this laptop).
- [ ] **Step 3: Commit**

```bash
git add pre-gke/
git commit -m "feat(m2): manifest env/resource updates for real agent images"
```

---

### Task 7: Chat CLI + rune handoff

**Files:**
- Create: `scripts/chat.ts`
- Modify: `pre-gke/README.md` (append "M2 handoff (rune)"), root `README.md` (add chat usage)

**Interfaces:** consumes protocol helpers; produces the M2 acceptance path.

- [ ] **Step 1: Write `scripts/chat.ts`** — a terminal chat client (rune's box or anywhere with NATS access + tsx):

```ts
// Usage: NATS_URL=nats://10.3.10.4:<nats-client NodePort> npx tsx scripts/chat.ts
import { connect, consumerOpts } from "nats";
import readline from "node:readline";
import {
  Envelope, ensureStream, makeEnvelope, newContextId, newCorrelationId,
  newTaskId, parseEnvelope, submitTask,
} from "@a2a-demo/protocol";

const url = process.env.NATS_URL;
if (!url) {
  console.error("NATS_URL is required, e.g. NATS_URL=nats://10.3.10.4:<nodePort> npx tsx scripts/chat.ts");
  process.exit(1);
}

const nc = await connect({ servers: url });
await ensureStream(await nc.jetstreamManager());
const from = { session: "terminal", agentType: "human" };

// One wildcard live tap on ALL task events: chatops replies print bare,
// delegate chunks print prefixed with their session name — the demo's interleaving.
const opts = consumerOpts();
opts.orderedConsumer();
opts.deliverNew();
const tap = await nc.jetstream().subscribe("a2a.tasks.*.events", opts);
(async () => {
  for await (const m of tap) {
    let env: Envelope;
    try { env = parseEnvelope(m.data); } catch { continue; }
    if (env.kind !== "message-chunk") continue;
    const text = (env.payload as { parts?: { text?: string }[] }).parts?.[0]?.text ?? "";
    if (env.from.session === "chatops") process.stdout.write(text);
    else process.stdout.write(`\n[${env.from.session}] ${text}`);
  }
})().catch(() => {});

const rl = readline.createInterface({ input: process.stdin });
console.log("chat> type a message; Ctrl-D to exit");
for await (const line of rl) {
  if (!line.trim()) continue;
  const taskId = newTaskId();
  const contextId = newContextId();
  await submitTask(nc, makeEnvelope({
    kind: "task", correlationId: newCorrelationId(), taskId,
    contextId, from, to: { session: "chatops" },
    payload: { id: taskId, contextId, prompt: line,
      status: { state: "submitted", timestamp: new Date().toISOString() } },
  }));
}
tap.unsubscribe();
await nc.close();
```

- [ ] **Step 2: Test the client against fakes** — run local `nats-server -js -p 4342`, run `scripts/smoke.ts`'s fake worker pattern in one process and pipe a line into chat.ts; verify interleaved `[worker-…]` output appears. (Scriptable: `echo "hello" | NATS_URL=… npx tsx scripts/chat.ts` with a stub chatops responder started first — write a 20-line `scripts/fake-chatops.ts` reusing smoke's worker function; it is throwaway test tooling, keep it.)

- [ ] **Step 3: Append "M2 handoff (rune)" to `pre-gke/README.md`:**

```markdown
## M2 handoff (rune)

1. Create the API key secret (once, never committed):
   `kubectl -n a2a-demo create secret generic a2a-demo-secrets --from-literal=ANTHROPIC_API_KEY=sk-...`
2. Build + push from repo root:
   `docker build --target worker  -t 10.3.10.52:5000/a2a-demo/worker:latest  -f agents/Dockerfile . && docker push 10.3.10.52:5000/a2a-demo/worker:latest`
   `docker build --target chatops -t 10.3.10.52:5000/a2a-demo/chatops:latest -f agents/Dockerfile . && docker push 10.3.10.52:5000/a2a-demo/chatops:latest`
3. `kubectl apply -k pre-gke/` then `kubectl -n a2a-demo rollout restart deploy chatops`.
4. Verify: chatops pod Running, logs show "agent-card published" style startup; then
   `NATS_URL=nats://10.3.10.4:<nats-client NodePort> npx tsx scripts/chat.ts`
   → type: `Delegate a task: write a haiku about NATS, then report back.`
   → expect: chatops replies with a session name; `[worker-…]` chunks interleave;
     `kubectl -n a2a-demo get pods` shows the worker pod appear and complete;
     asking `what is session worker-… doing?` gets a summary from replay.
5. Report the transcript + `kubectl -n a2a-demo get pods -w` output back via PR comment.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/ pre-gke/README.md README.md
git commit -m "feat(m2): terminal chat client and rune handoff instructions"
```

---

## After M2

M2 done = rune's transcript shows delegation, interleaved streaming, status-by-replay, and pod GC on the real cluster. Then M3: web UI (NATS WebSocket, chat pane + live topology), which consumes exactly what chat.ts consumes — no agent changes expected.
