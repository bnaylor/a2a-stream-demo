# A2A Demo M1 — Protocol Library + Bus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested TypeScript `a2a-jetstream` protocol library plus a smoke test proving delegate → stream → replay end-to-end against a real NATS, ready for the M2 agents to build on.

**Architecture:** A2A message shapes (Task, TaskStatusUpdateEvent, Artifact) wrapped in a versioned JSON envelope, published to JetStream subjects `a2a.tasks.{taskId}.request|events` captured by one durable stream `A2A`. Status queries are stream replays. Heartbeats are core-NATS (outside the stream), Synadia-compatible.

**Tech Stack:** Node 22, TypeScript (strict, ESM), `nats` ^2.29 (only runtime dep), vitest, tsx. npm workspaces (`protocol` now; `agents/*`, `web` in M2/M3).

**Spec:** `docs/superpowers/specs/2026-08-19-a2a-jetstream-demo-design.md` (§3 is the protocol contract; copy values from it verbatim).

## Global Constraints

- Runtime dependency limit: `nats@^2.29` only. Dev deps: `typescript`, `vitest`, `tsx`, `@types/node`.
- Subjects, verbatim from spec §3.2: `a2a.tasks.{taskId}.request`, `a2a.tasks.{taskId}.events`, `a2a.agents.{session}`, `agents.hb.{agentType}.{owner}.{session}`.
- Envelope fields, verbatim from spec §3.3: `protocol: "a2a-jetstream/0.1"`, `correlationId`, `taskId`, `contextId`, `ts`, `from: {session, agentType}`, `kind`, `payload`.
- Stream `A2A`: subjects `a2a.>`, file storage, limits retention, max_age 24 h, max_bytes 256 MB (spec §3.1).
- Task states: `submitted → working → completed | failed | canceled`; terminal status-update has `final: true` (spec §3.4).
- Heartbeat every 15 s, payload keys `agent`, `owner`, `session`, `instance_id`, `ts`, `interval_s` (spec §3.2).
- Integration tests and the smoke script require env `NATS_URL`; without it, integration tests SKIP (never fail) and smoke exits with a clear error. There is no docker on this laptop — a local `nats-server` (`brew install nats-server`, run `nats-server -js`) or the cluster NodePort are the two ways to get a `NATS_URL`.
- **NEVER run `kubectl apply` from this laptop** — its kubectl context is a GKE cluster, not the homelab (see `pre-gke/README.md`). Manifest changes are committed to `pre-gke/` and applied by rune.
- No secrets committed, ever.

---

### Task 1: Repo scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `protocol/package.json`, `protocol/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: npm workspace `@a2a-demo/protocol` importable from tests and `scripts/`; `npm test` (vitest), `npm run typecheck` (tsc) both green.

- [ ] **Step 1: Write the files**

`package.json`:

```json
{
  "name": "a2a-stream-demo",
  "private": true,
  "type": "module",
  "workspaces": ["protocol"],
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx scripts/smoke.ts"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["protocol/src", "scripts"]
}
```

`.gitignore`:

```
node_modules/
dist/
*.log
```

`protocol/package.json`:

```json
{
  "name": "@a2a-demo/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "nats": "^2.29.0"
  }
}
```

`protocol/src/index.ts` (grows as modules land):

```ts
export {};
```

- [ ] **Step 2: Install and verify**

Run: `npm install && npm run typecheck && npm test`
Expected: install succeeds, tsc clean, vitest reports "no test files found" but exits 0 (`--passWithNoTests`).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore protocol/
git commit -m "feat(m1): scaffold npm workspace with protocol package"
```

---

### Task 2: Wire spec document

**Files:**
- Create: `protocol/SPEC.md`

**Interfaces:**
- Consumes: design spec §3.
- Produces: the standalone wire contract M2 agents and the M3 browser UI implement against.

- [ ] **Step 1: Write `protocol/SPEC.md`**

Content: title `a2a-jetstream v0.1`; then, copied/condensed from design spec §3 (keep values identical, do not paraphrase numbers or field names):

1. **Stream** — table: name `A2A`, subjects `a2a.>`, file storage, limits retention, max_age 24 h, max_bytes 256 MB. Note: heartbeats are core NATS, outside the stream.
2. **Subjects** — the four subject patterns from Global Constraints, each with one sentence of purpose.
3. **Envelope** — the exact JSON example from design spec §3.3, plus field rules: `taskId`/`contextId` required for kinds `task`, `status-update`, `message-chunk`, `artifact-update`; optional for `agent-card`, `agent-closed`. `ts` is ISO-8601 UTC. `kind` enum: `task | status-update | message-chunk | artifact-update | agent-card | agent-closed`.
4. **Lifecycle** — states `submitted → working → completed | failed | canceled`; terminal status-update carries `final: true`; status queries = replay of `a2a.tasks.{taskId}.events`.
5. **Heartbeats** — subject pattern, 15 s interval, payload example:
   `{"agent":"claude-code","owner":"bnaylor","session":"chatops","instance_id":"<uuid>","ts":"2026-08-19T21:00:00Z","interval_s":15}` — Synadia-compatible shape.
6. **Versioning** — `protocol` field is bumped on breaking change; consumers MUST ignore unknown envelope fields and MUST reject unknown `protocol` values.

- [ ] **Step 2: Commit**

```bash
git add protocol/SPEC.md
git commit -m "docs(m1): a2a-jetstream v0.1 wire spec"
```

---

### Task 3: IDs and subjects

**Files:**
- Create: `protocol/src/ids.ts`, `protocol/src/subjects.ts`
- Test: `protocol/src/ids.test.ts`, `protocol/src/subjects.test.ts`
- Modify: `protocol/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `newTaskId(): string`, `newContextId(): string`, `newCorrelationId(): string`, `newSessionName(): string`; `taskRequestSubject(taskId: string): string`, `taskEventsSubject(taskId: string): string`, `agentCardSubject(session: string): string`, `heartbeatSubject(agentType: string, owner: string, session: string): string`, `taskIdFromSubject(subject: string): string | null`.

- [ ] **Step 1: Write the failing tests**

`protocol/src/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newCorrelationId, newSessionName, newTaskId } from "./ids.ts";

describe("ids", () => {
  it("prefixes ids by kind", () => {
    expect(newTaskId()).toMatch(/^task-[0-9a-f-]{36}$/);
    expect(newCorrelationId()).toMatch(/^corr-[0-9a-f-]{36}$/);
  });
  it("generates worker-adjective-animal session names", () => {
    expect(newSessionName()).toMatch(/^worker-[a-z]+-[a-z]+$/);
  });
  it("does not repeat task ids", () => {
    expect(newTaskId()).not.toEqual(newTaskId());
  });
});
```

`protocol/src/subjects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  agentCardSubject, heartbeatSubject, taskEventsSubject,
  taskIdFromSubject, taskRequestSubject,
} from "./subjects.ts";

describe("subjects", () => {
  it("builds spec §3.2 subjects verbatim", () => {
    expect(taskRequestSubject("task-1")).toBe("a2a.tasks.task-1.request");
    expect(taskEventsSubject("task-1")).toBe("a2a.tasks.task-1.events");
    expect(agentCardSubject("worker-brisk-otter")).toBe("a2a.agents.worker-brisk-otter");
    expect(heartbeatSubject("claude-code", "bnaylor", "chatops"))
      .toBe("agents.hb.claude-code.bnaylor.chatops");
  });
  it("rejects tokens containing NATS-reserved characters", () => {
    for (const bad of ["a.b", "a b", "a*", "a>", ""]) {
      expect(() => taskRequestSubject(bad)).toThrow(/invalid subject token/);
    }
  });
  it("extracts taskId from task subjects, null otherwise", () => {
    expect(taskIdFromSubject("a2a.tasks.task-9.events")).toBe("task-9");
    expect(taskIdFromSubject("a2a.tasks.task-9.request")).toBe("task-9");
    expect(taskIdFromSubject("a2a.agents.chatops")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run protocol/src/ids.test.ts protocol/src/subjects.test.ts`
Expected: FAIL — cannot resolve `./ids.ts` / `./subjects.ts`.

- [ ] **Step 3: Write the implementations**

`protocol/src/ids.ts`:

```ts
import { randomInt, randomUUID } from "node:crypto";

export const newTaskId = (): string => `task-${randomUUID()}`;
export const newContextId = (): string => `ctx-${randomUUID()}`;
export const newCorrelationId = (): string => `corr-${randomUUID()}`;

const ADJECTIVES = ["brisk", "calm", "deft", "eager", "fuzzy", "keen", "merry", "nimble"];
const ANIMALS = ["otter", "heron", "lynx", "marmot", "puffin", "stoat", "tapir", "wren"];

export const newSessionName = (): string =>
  `worker-${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${ANIMALS[randomInt(ANIMALS.length)]}`;
```

`protocol/src/subjects.ts`:

```ts
function assertToken(token: string): string {
  if (token === "" || /[.\s*>]/.test(token)) {
    throw new Error(`invalid subject token: ${JSON.stringify(token)}`);
  }
  return token;
}

export const taskRequestSubject = (taskId: string): string =>
  `a2a.tasks.${assertToken(taskId)}.request`;
export const taskEventsSubject = (taskId: string): string =>
  `a2a.tasks.${assertToken(taskId)}.events`;
export const agentCardSubject = (session: string): string =>
  `a2a.agents.${assertToken(session)}`;
export const heartbeatSubject = (agentType: string, owner: string, session: string): string =>
  `agents.hb.${assertToken(agentType)}.${assertToken(owner)}.${assertToken(session)}`;

export function taskIdFromSubject(subject: string): string | null {
  const m = /^a2a\.tasks\.([^.]+)\.(request|events)$/.exec(subject);
  return m ? m[1] : null;
}
```

Add to `protocol/src/index.ts`:

```ts
export * from "./ids.ts";
export * from "./subjects.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run protocol/src/ids.test.ts protocol/src/subjects.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add protocol/src/
git commit -m "feat(m1): id generators and subject builders"
```

---

### Task 4: A2A types and envelope

**Files:**
- Create: `protocol/src/types.ts`, `protocol/src/envelope.ts`
- Test: `protocol/src/envelope.test.ts`
- Modify: `protocol/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: types `TaskState`, `TaskStatus`, `Task`, `MessagePart`, `A2AMessage`, `TaskStatusUpdate`, `Artifact`, `EnvelopeKind`, `Envelope<P>`, `AgentIdentity`; functions `makeEnvelope(input): Envelope`, `encodeEnvelope(env): Uint8Array`, `parseEnvelope(data: Uint8Array | string): Envelope` (throws `EnvelopeError` on invalid), constant `PROTOCOL_VERSION = "a2a-jetstream/0.1"`.

- [ ] **Step 1: Write the failing test**

`protocol/src/envelope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  EnvelopeError, PROTOCOL_VERSION, encodeEnvelope, makeEnvelope, parseEnvelope,
} from "./envelope.ts";

const from = { session: "chatops", agentType: "claude-code" };

describe("envelope", () => {
  it("round-trips through encode/parse", () => {
    const env = makeEnvelope({
      kind: "status-update",
      correlationId: "corr-1", taskId: "task-1", contextId: "ctx-1",
      from, payload: { taskId: "task-1", contextId: "ctx-1",
        status: { state: "working", timestamp: "2026-08-19T21:00:00Z" }, final: false },
    });
    expect(env.protocol).toBe(PROTOCOL_VERSION);
    expect(Date.parse(env.ts)).not.toBeNaN();
    expect(parseEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it("requires taskId/contextId for task-scoped kinds", () => {
    expect(() =>
      makeEnvelope({ kind: "message-chunk", correlationId: "corr-1", from, payload: {} }),
    ).toThrow(EnvelopeError);
  });

  it("allows agent-card without taskId", () => {
    const env = makeEnvelope({ kind: "agent-card", correlationId: "corr-1", from, payload: { name: "chatops" } });
    expect(env.taskId).toBeUndefined();
  });

  it.each([
    ["not json", "{"],
    ["wrong protocol", JSON.stringify({ protocol: "a2a-jetstream/9.9" })],
    ["missing from", JSON.stringify({ protocol: PROTOCOL_VERSION, correlationId: "c", ts: "t", kind: "agent-card", payload: {} })],
    ["bad kind", JSON.stringify({ protocol: PROTOCOL_VERSION, correlationId: "c", ts: "t", kind: "nope", from: { session: "s", agentType: "a" }, payload: {} })],
  ])("rejects invalid input: %s", (_name, raw) => {
    expect(() => parseEnvelope(raw)).toThrow(EnvelopeError);
  });

  it("ignores unknown fields (forward compat)", () => {
    const raw = JSON.stringify({
      protocol: PROTOCOL_VERSION, correlationId: "c", ts: "2026-08-19T21:00:00Z",
      kind: "agent-card", from, payload: {}, futureField: 42,
    });
    expect(parseEnvelope(raw).kind).toBe("agent-card");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run protocol/src/envelope.test.ts`
Expected: FAIL — cannot resolve `./envelope.ts`.

- [ ] **Step 3: Write the implementations**

`protocol/src/types.ts`:

```ts
export type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled";

export interface TaskStatus {
  state: TaskState;
  timestamp: string; // ISO-8601 UTC
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
}

export interface MessagePart {
  kind: "text";
  text: string;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: MessagePart[];
  messageId: string;
}

export interface TaskStatusUpdate {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final: boolean;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: MessagePart[];
}

export interface AgentIdentity {
  agentType: string; // e.g. "claude-code"
  owner: string;     // e.g. "bnaylor"
  session: string;   // e.g. "chatops", "worker-brisk-otter"
  instanceId: string;
}
```

`protocol/src/envelope.ts`:

```ts
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
```

Add to `protocol/src/index.ts`:

```ts
export * from "./types.ts";
export * from "./envelope.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run protocol/src/envelope.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add protocol/src/
git commit -m "feat(m1): A2A types and versioned envelope codec"
```

---

### Task 5: Stream management

**Files:**
- Create: `protocol/src/stream.ts`
- Test: `protocol/src/stream.test.ts`
- Modify: `protocol/src/index.ts`

**Interfaces:**
- Consumes: nothing internal.
- Produces: `STREAM_NAME = "A2A"`, `ensureStream(jsm: JetStreamManager): Promise<void>` — idempotent create-or-update to the spec §3.1 config.

- [ ] **Step 1: Write the (gated) integration test**

`protocol/src/stream.test.ts`:

```ts
import { connect } from "nats";
import { describe, expect, it } from "vitest";
import { STREAM_NAME, ensureStream } from "./stream.ts";

const url = process.env.NATS_URL;

describe.skipIf(!url)("ensureStream (requires NATS_URL)", () => {
  it("creates the A2A stream idempotently with spec config", async () => {
    const nc = await connect({ servers: url });
    try {
      const jsm = await nc.jetstreamManager();
      await ensureStream(jsm);
      await ensureStream(jsm); // idempotent
      const info = await jsm.streams.info(STREAM_NAME);
      expect(info.config.subjects).toEqual(["a2a.>"]);
      expect(info.config.max_bytes).toBe(256 * 1024 * 1024);
      expect(info.config.max_age).toBe(24 * 60 * 60 * 1_000_000_000);
      expect(info.config.storage).toBe("file");
    } finally {
      await nc.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify behavior**

Run: `npx vitest run protocol/src/stream.test.ts`
Expected without `NATS_URL`: suite SKIPPED, exit 0. If a local `nats-server -js` is available: FAIL (module missing) — either outcome confirms the gate works.

- [ ] **Step 3: Write the implementation**

`protocol/src/stream.ts`:

```ts
import { JetStreamManager, RetentionPolicy, StorageType, StreamConfig } from "nats";

export const STREAM_NAME = "A2A";

const CONFIG: Partial<StreamConfig> = {
  name: STREAM_NAME,
  subjects: ["a2a.>"],
  storage: StorageType.File,
  retention: RetentionPolicy.Limits,
  max_age: 24 * 60 * 60 * 1_000_000_000, // 24 h in ns
  max_bytes: 256 * 1024 * 1024,
};

export async function ensureStream(jsm: JetStreamManager): Promise<void> {
  try {
    await jsm.streams.info(STREAM_NAME);
    await jsm.streams.update(STREAM_NAME, CONFIG);
  } catch {
    await jsm.streams.add(CONFIG);
  }
}
```

Add to `protocol/src/index.ts`: `export * from "./stream.ts";`

- [ ] **Step 4: Run tests**

Run: `npx vitest run protocol/src/stream.test.ts && npm run typecheck`
Expected: SKIP (no NATS_URL) or PASS (with NATS_URL); tsc clean. If `brew install nats-server` is acceptable, run `nats-server -js -p 4333 &` then `NATS_URL=nats://127.0.0.1:4333 npx vitest run protocol/src/stream.test.ts` and expect PASS; kill the server after.

- [ ] **Step 5: Commit**

```bash
git add protocol/src/
git commit -m "feat(m1): idempotent A2A stream provisioning"
```

---

### Task 6: Heartbeats

**Files:**
- Create: `protocol/src/heartbeat.ts`
- Test: `protocol/src/heartbeat.test.ts`
- Modify: `protocol/src/index.ts`

**Interfaces:**
- Consumes: `AgentIdentity` (Task 4), `heartbeatSubject` (Task 3).
- Produces: `makeHeartbeat(id: AgentIdentity, now: Date, intervalS?: number): Heartbeat`, `startHeartbeat(nc: NatsConnection, id: AgentIdentity, intervalS?: number): () => void` (returns stop function; publishes immediately, then every `intervalS`).

- [ ] **Step 1: Write the failing test**

`protocol/src/heartbeat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeHeartbeat } from "./heartbeat.ts";

describe("heartbeat", () => {
  it("builds Synadia-compatible payloads (spec §3.2 keys)", () => {
    const hb = makeHeartbeat(
      { agentType: "claude-code", owner: "bnaylor", session: "chatops", instanceId: "i-1" },
      new Date("2026-08-19T21:00:00Z"),
    );
    expect(hb).toEqual({
      agent: "claude-code",
      owner: "bnaylor",
      session: "chatops",
      instance_id: "i-1",
      ts: "2026-08-19T21:00:00.000Z",
      interval_s: 15,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run protocol/src/heartbeat.test.ts`
Expected: FAIL — cannot resolve `./heartbeat.ts`.

- [ ] **Step 3: Write the implementation**

`protocol/src/heartbeat.ts`:

```ts
import { NatsConnection } from "nats";
import { heartbeatSubject } from "./subjects.ts";
import { AgentIdentity } from "./types.ts";

export interface Heartbeat {
  agent: string;
  owner: string;
  session: string;
  instance_id: string;
  ts: string;
  interval_s: number;
}

export function makeHeartbeat(id: AgentIdentity, now: Date, intervalS = 15): Heartbeat {
  return {
    agent: id.agentType,
    owner: id.owner,
    session: id.session,
    instance_id: id.instanceId,
    ts: now.toISOString(),
    interval_s: intervalS,
  };
}

export function startHeartbeat(nc: NatsConnection, id: AgentIdentity, intervalS = 15): () => void {
  const subject = heartbeatSubject(id.agentType, id.owner, id.session);
  const publish = () =>
    nc.publish(subject, JSON.stringify(makeHeartbeat(id, new Date(), intervalS)));
  publish();
  const timer = setInterval(publish, intervalS * 1000);
  return () => clearInterval(timer);
}
```

Add to `protocol/src/index.ts`: `export * from "./heartbeat.ts";`

- [ ] **Step 4: Run tests**

Run: `npx vitest run protocol/src/heartbeat.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add protocol/src/
git commit -m "feat(m1): heartbeat payloads and publisher loop"
```

---

### Task 7: Publish / replay / live-subscribe client

**Files:**
- Create: `protocol/src/client.ts`
- Test: `protocol/src/client.test.ts`
- Modify: `protocol/src/index.ts`

**Interfaces:**
- Consumes: `Envelope`, `encodeEnvelope`, `parseEnvelope` (Task 4); subjects (Task 3); `STREAM_NAME`, `ensureStream` (Task 5).
- Produces:
  - `publishEnvelope(nc: NatsConnection, subject: string, env: Envelope): Promise<void>` (JetStream publish)
  - `replayTaskEvents(nc: NatsConnection, taskId: string): Promise<Envelope[]>` — cold replay of everything on the events subject; `[]` if none.
  - `subscribeTaskEvents(nc: NatsConnection, taskId: string, onEnvelope: (env: Envelope) => void): Promise<() => void>` — replay-then-live (ordered consumer, deliver-all); returns unsubscribe.

- [ ] **Step 1: Write the (gated) integration test**

`protocol/src/client.test.ts`:

```ts
import { connect } from "nats";
import { describe, expect, it } from "vitest";
import { makeEnvelope, Envelope } from "./envelope.ts";
import { newTaskId } from "./ids.ts";
import { publishEnvelope, replayTaskEvents, subscribeTaskEvents } from "./client.ts";
import { ensureStream } from "./stream.ts";
import { taskEventsSubject } from "./subjects.ts";

const url = process.env.NATS_URL;
const from = { session: "test", agentType: "test" };

describe.skipIf(!url)("client (requires NATS_URL)", () => {
  it("publishes, replays cold, and streams live", async () => {
    const nc = await connect({ servers: url });
    try {
      await ensureStream(await nc.jetstreamManager());
      const taskId = newTaskId();
      const subject = taskEventsSubject(taskId);
      const mk = (i: number) =>
        makeEnvelope({ kind: "message-chunk", correlationId: "corr-t", taskId,
          contextId: "ctx-t", from, payload: { seq: i } });

      await publishEnvelope(nc, subject, mk(0));
      await publishEnvelope(nc, subject, mk(1));

      // Cold replay sees both, in order.
      const replayed = await replayTaskEvents(nc, taskId);
      expect(replayed.map((e) => (e.payload as { seq: number }).seq)).toEqual([0, 1]);

      // Unknown task replays empty.
      expect(await replayTaskEvents(nc, newTaskId())).toEqual([]);

      // Live subscription replays history then receives new messages.
      const seen: Envelope[] = [];
      const stop = await subscribeTaskEvents(nc, taskId, (e) => seen.push(e));
      await publishEnvelope(nc, subject, mk(2));
      await new Promise((r) => setTimeout(r, 500));
      stop();
      expect(seen.map((e) => (e.payload as { seq: number }).seq)).toEqual([0, 1, 2]);
    } finally {
      await nc.close();
    }
  }, 15_000);
});
```

- [ ] **Step 2: Run test to verify the gate / failure**

Run: `npx vitest run protocol/src/client.test.ts`
Expected: SKIPPED without `NATS_URL`; with it, FAIL (module missing).

- [ ] **Step 3: Write the implementation**

`protocol/src/client.ts`:

```ts
import { NatsConnection, consumerOpts } from "nats";
import { Envelope, encodeEnvelope, parseEnvelope } from "./envelope.ts";
import { STREAM_NAME } from "./stream.ts";
import { taskEventsSubject } from "./subjects.ts";

export async function publishEnvelope(
  nc: NatsConnection, subject: string, env: Envelope,
): Promise<void> {
  await nc.jetstream().publish(subject, encodeEnvelope(env));
}

async function countMessages(nc: NatsConnection, subject: string): Promise<number> {
  const jsm = await nc.jetstreamManager();
  const info = await jsm.streams.info(STREAM_NAME, { subjects_filter: subject });
  return info.state.subjects?.[subject] ?? 0;
}

export async function replayTaskEvents(nc: NatsConnection, taskId: string): Promise<Envelope[]> {
  const subject = taskEventsSubject(taskId);
  const count = await countMessages(nc, subject);
  if (count === 0) return [];
  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.deliverAll();
  const sub = await nc.jetstream().subscribe(subject, opts);
  const out: Envelope[] = [];
  for await (const m of sub) {
    out.push(parseEnvelope(m.data));
    if (out.length >= count) break;
  }
  sub.unsubscribe();
  return out;
}

export async function subscribeTaskEvents(
  nc: NatsConnection, taskId: string, onEnvelope: (env: Envelope) => void,
): Promise<() => void> {
  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.deliverAll();
  const sub = await nc.jetstream().subscribe(taskEventsSubject(taskId), opts);
  (async () => {
    for await (const m of sub) onEnvelope(parseEnvelope(m.data));
  })().catch(() => { /* subscription closed */ });
  return () => sub.unsubscribe();
}
```

Add to `protocol/src/index.ts`: `export * from "./client.ts";`

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npx vitest run protocol/src/client.test.ts`
Without `NATS_URL`: SKIP. With a local `nats-server -js -p 4333` and `NATS_URL=nats://127.0.0.1:4333`: PASS. Note: `js.subscribe` on a subject with no matching stream messages still works — the empty-replay case is handled by the `countMessages` early return, not the consumer.

- [ ] **Step 5: Commit**

```bash
git add protocol/src/
git commit -m "feat(m1): publish, cold-replay, and live-subscribe helpers"
```

---

### Task 8: Smoke test — fake delegator + fake worker

**Files:**
- Create: `scripts/smoke.ts`

**Interfaces:**
- Consumes: everything from `@a2a-demo/protocol` (Tasks 3–7).
- Produces: `npm run smoke` — exits 0 iff delegate → stream → live-stream → cold-replay all worked against `$NATS_URL`. This is the M1 acceptance gate (spec §6).

- [ ] **Step 1: Write `scripts/smoke.ts`**

```ts
import { connect } from "nats";
import {
  ensureStream, makeEnvelope, newContextId, newCorrelationId, newSessionName,
  newTaskId, publishEnvelope, replayTaskEvents, subscribeTaskEvents,
  taskEventsSubject, taskRequestSubject, startHeartbeat,
  Envelope, TaskStatusUpdate,
} from "@a2a-demo/protocol";

const url = process.env.NATS_URL;
if (!url) {
  console.error("NATS_URL is required, e.g. NATS_URL=nats://10.3.10.4:<nodePort> npm run smoke");
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

const nc = await connect({ servers: url });
await ensureStream(await nc.jetstreamManager());

// --- fake worker: consumes a task request, streams events, finishes ---
const session = newSessionName();
const workerFrom = { session, agentType: "fake-worker" };
async function runWorker(taskId: string, contextId: string, correlationId: string) {
  const events = taskEventsSubject(taskId);
  const status = (state: TaskStatusUpdate["status"]["state"], final: boolean) =>
    publishEnvelope(nc, events, makeEnvelope({
      kind: "status-update", correlationId, taskId, contextId, from: workerFrom,
      payload: { taskId, contextId, status: { state, timestamp: new Date().toISOString() }, final },
    }));
  await status("working", false);
  for (const word of ["thinking…", "chunk one", "chunk two"]) {
    await publishEnvelope(nc, events, makeEnvelope({
      kind: "message-chunk", correlationId, taskId, contextId, from: workerFrom,
      payload: { role: "agent", messageId: newTaskId(), parts: [{ kind: "text", text: word }] },
    }));
  }
  await publishEnvelope(nc, events, makeEnvelope({
    kind: "artifact-update", correlationId, taskId, contextId, from: workerFrom,
    payload: { artifactId: "artifact-1", name: "result", parts: [{ kind: "text", text: "42" }] },
  }));
  await status("completed", true);
}

// --- fake delegator: submits the task, watches the live stream ---
const taskId = newTaskId();
const contextId = newContextId();
const correlationId = newCorrelationId();
const delegatorFrom = { session: "chatops-smoke", agentType: "fake-delegator" };
const stopHb = startHeartbeat(nc, {
  agentType: "fake-delegator", owner: "bnaylor", session: "chatops-smoke", instanceId: taskId,
});

const live: Envelope[] = [];
let sawFinal: (() => void) | undefined;
const done = new Promise<void>((resolve) => { sawFinal = resolve; });
const stopSub = await subscribeTaskEvents(nc, taskId, (env) => {
  live.push(env);
  console.log(`[${env.from.session}] ${env.kind}`);
  if (env.kind === "status-update" && (env.payload as TaskStatusUpdate).final) sawFinal!();
});

await publishEnvelope(nc, taskRequestSubject(taskId), makeEnvelope({
  kind: "task", correlationId, taskId, contextId, from: delegatorFrom,
  payload: { id: taskId, contextId, status: { state: "submitted", timestamp: new Date().toISOString() } },
}));
await runWorker(taskId, contextId, correlationId);

await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000))])
  .catch((e) => fail(`no terminal event within 10s: ${e}`));
stopSub();
stopHb();

// --- assertions ---
if (live.length !== 6) fail(`expected 6 live events, saw ${live.length}`);
if (live.some((e) => e.correlationId !== correlationId)) fail("correlationId not preserved across hops");

// Demo purpose #2: a cold replay reconstructs the full task history.
const replayed = await replayTaskEvents(nc, taskId);
if (replayed.length !== 6) fail(`cold replay expected 6 events, saw ${replayed.length}`);
if (replayed.map((e) => e.kind).join(",") !==
    "status-update,message-chunk,message-chunk,message-chunk,artifact-update,status-update") {
  fail(`unexpected replay order: ${replayed.map((e) => e.kind).join(",")}`);
}

console.log(`SMOKE PASS: task ${taskId} delegated to ${session}, 6 events streamed live and replayed cold.`);
await nc.close();
```

- [ ] **Step 2: Run against a NATS**

Run (local): `nats-server -js -p 4333 & NATS_URL=nats://127.0.0.1:4333 npm run smoke; kill %1`
Or (cluster, once rune has applied `pre-gke/` and reported the client NodePort — see Task 9): `NATS_URL=nats://10.3.10.4:<nodePort> npm run smoke`
Expected: `SMOKE PASS: …`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.ts
git commit -m "feat(m1): end-to-end smoke test with fake delegator and worker"
```

---

### Task 9: Cluster client access + rune handoff

**Files:**
- Create: `pre-gke/nats-client-svc.yaml`
- Modify: `pre-gke/kustomization.yaml` (add the new file to `resources:`), `pre-gke/README.md` (handoff section), `README.md` (create — repo front door)

**Interfaces:**
- Consumes: existing `pre-gke/` manifests.
- Produces: a NodePort for NATS client port 4222 so the laptop can run `npm run smoke` against the cluster; written handoff instructions for rune.

- [ ] **Step 1: Write `pre-gke/nats-client-svc.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nats-client
  namespace: a2a-demo
spec:
  selector:
    app: nats
  ports:
    - name: client
      port: 4222
      targetPort: 4222
      # NodePort so the dev laptop can run the M1 smoke test against the
      # cluster bus: NATS_URL=nats://10.3.10.<node>:<nodePort>. The demo NATS
      # is unauthenticated by design (spec §1 non-goal) — homelab LAN only.
  type: NodePort
```

Add `- nats-client-svc.yaml` to the `resources:` list in `pre-gke/kustomization.yaml` (after `nats-ws-svc.yaml`).

- [ ] **Step 2: Append a handoff section to `pre-gke/README.md`**

```markdown
## M1 handoff (rune)

1. `kubectl apply -k pre-gke/` (from a microk8s-context machine — see warning above).
   Expected ready: `nats-0` running; `chatops`/`web` will ImagePullBackOff (images land in M2/M3 — that's fine).
2. Report back (commit to this README or PR comment):
   - `kubectl -n a2a-demo get svc nats-client nats-ws web -o wide` → the assigned NodePorts.
3. scromp then runs from the laptop: `NATS_URL=nats://10.3.10.4:<nats-client NodePort> npm run smoke`
   → expected output `SMOKE PASS: …`.
```

- [ ] **Step 3: Write `README.md` (repo front door)**

````markdown
# a2a-stream-demo

Demo: A2A message semantics over NATS JetStream for ephemeral agent
delegation in Kubernetes. ChatOps agent delegates tasks to ephemeral
worker pods; results stream back live; the durable stream lets the
delegator answer "what is session X doing?" by replay.

- Design spec: `docs/superpowers/specs/2026-08-19-a2a-jetstream-demo-design.md`
- Wire protocol: `protocol/SPEC.md`
- Cluster manifests (homelab, pre-GKE): `pre-gke/`
- M1 plan: `docs/superpowers/plans/2026-08-19-a2a-demo-m1-protocol.md`

## Dev

```bash
npm install
npm test                # unit tests (integration tests skip without NATS_URL)
npm run typecheck
NATS_URL=nats://…:4222 npm run smoke   # end-to-end against a real NATS
```
````

- [ ] **Step 4: Verify kustomize builds**

Run: `kubectl kustomize pre-gke/ > /dev/null && echo OK` (rendering only — **do not apply**; laptop context is GKE).
Expected: `OK`.

- [ ] **Step 5: Commit and push**

```bash
git add pre-gke/ README.md
git commit -m "feat(m1): NATS client NodePort and M1 handoff instructions for rune"
git push origin main
```

---

## After M1

M1 is complete when rune has applied the manifests and the smoke test passes from the laptop against the cluster bus. Then write the M2 plan (ChatOps + worker agents, Dockerfiles for rune) against the now-real protocol API, followed by M3 (web UI over the NATS WebSocket).
