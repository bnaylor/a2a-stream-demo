# A2A-over-JetStream Agent Delegation Demo — Design

**Date:** 2026-08-19
**Status:** Approved design, pre-implementation

## 1. Purpose

Demonstrate, ahead of the round_2 architecture revamp, that:

1. With A2A message semantics over NATS JetStream we can spin up ephemeral
   agents in Kubernetes, delegate tasks to them, and stream results back to
   the user in realtime.
2. The originating chat agent retains context: it can inspect the durable
   result streams of running/finished tasks and answer questions about what
   its delegates are doing — the exact capability the current
   kanban-card flow lacks.

**Explicit non-goal:** this demo carries none of the round_2 authority /
capability chain. It must not be presented as the security story
(round_2 `sequencing-alt.md` flags this risk itself). The local NATS runs
without auth; that is accepted for this demo.

## 2. Environment and deployment

- **Cluster:** bnaylor's homelab microk8s cluster (runs production-ish
  workloads — treat as shared infrastructure). Verified layout: 3 nodes
  (`dusty` 10.3.10.4, `lucky` 10.3.10.2, `ned` 10.3.10.3), containerd,
  v1.35.x. There is **no GKE** in play for this demo — GKE is the
  later overlay only.
- **Isolation rules:** everything lives in namespace `a2a-demo`. No
  cluster-scoped resources beyond the `a2a-demo` Namespace object
  itself. Every pod has CPU/memory
  requests and limits. Nothing references or depends on workloads
  outside the namespace.
- **NATS:** we deploy our own single-node NATS inside `a2a-demo`
  (hand-written StatefulSet + ConfigMap + Services, not Helm), with
  JetStream enabled (file storage on a small PVC, ~1Gi). The NATS
  ConfigMap **must** include an explicit WebSocket listener block
  (`websocket { port: 9222 }` or similar) — the cluster's existing
  `nats` install (10.3.10.55:4222) has **no** WebSocket listener, and
  the browser UI depends on WS. The existing NATS is ignored entirely
  (it is shared, prod-ish infrastructure; changing it is a separate
  scromp-sign-off). A fresh `a2a-demo` namespace has no NATS dependency.
- **Images:** the local agent (rune) builds images on the homelab build
  box and pushes to the **in-cluster registry at `10.3.10.52:5000`**
  (a.k.a. `registry.naylo.rs`), which is plain HTTP/insecure — Docker's
  `insecure-registries` already lists `10.3.10.52:5000` on the build
  box, and every existing cluster image already pulls
  `10.3.10.52:5000/...`. Image references are parameterized via the
  kustomize `images:` transformer with default prefix
  **`10.3.10.52:5000/a2a-demo/`** — use the IP form, not DNS, since
  the nodes' containerd is already configured to pull that IP
  insecurely. (The microk8s built-in registry `localhost:32000` is
  **not** enabled on this cluster — do not use it.)
- **Layout:** `deploy/base` + `deploy/overlays/local` (microk8s: registry
  prefix, NodePorts) and `deploy/overlays/gke` (written later; swaps
  image refs, ingress, and eventually Vertex auth). Until the GKE work
  happens, the local manifests + any iterated fixes live under a
  throwaway `pre-gke/` directory committed to this repo (no secrets) so
  rune and scromp can iterate and transfer files without manual scp.
- **LAN access:** two NodePort services — one for the static web UI, one
  for the NATS WebSocket port — so a browser on the LAN reaches both at
  `http://10.3.10.<node>:<NodePort>` / `ws://10.3.10.<node>:<NodePort>`.
  NodePort (not LoadBalancer) is deliberate: the MetalLB pool
  (`10.3.10.50–60`) is nearly full — only `.60` is free. The concrete
  node IP + NodePort are pinned in the `local` overlay.
- **Model auth:** personal `ANTHROPIC_API_KEY` in a k8s Secret
  (created out-of-band, never committed), mounted into ChatOps and
  worker pods. Vertex via Workload Identity is the GKE-overlay follow-up.

## 3. Protocol: `a2a-jetstream` v0.1

A small spec (`protocol/SPEC.md`) plus a shared TypeScript library
(`protocol/`) used by every component including the browser UI.

### 3.1 Stream

One JetStream stream:

| Field | Value |
|---|---|
| Name | `A2A` |
| Subjects | `a2a.>` |
| Storage | file |
| Retention | limits: 24 h age, 256 MB |

Heartbeats deliberately stay **outside** the stream (core NATS) so the
audit stream isn't noise.

### 3.2 Subjects

- `a2a.tasks.{taskId}.request` — task submission (one message).
- `a2a.tasks.{taskId}.events` — everything the executing agent emits:
  status updates, streamed message chunks, artifacts, terminal event.
- `a2a.agents.{session}` — agent card, published once on startup and a
  closing tombstone on shutdown (durable, so the UI can replay topology).
- `agents.hb.{agentType}.{owner}.{session}` — core-NATS heartbeat every
  15 s, Synadia-compatible payload shape (`agent`, `owner`, `session`,
  `instance_id`, `ts`, `interval_s`).

Synadia's conventions are borrowed only where they don't conflict with
A2A: heartbeat subject shape and payload. Task semantics are pure A2A.

### 3.3 Envelope

Every JetStream message is JSON:

```json
{
  "protocol": "a2a-jetstream/0.1",
  "correlationId": "corr-…",
  "taskId": "task-…",
  "contextId": "ctx-…",
  "ts": "2026-08-19T21:00:00Z",
  "from": { "session": "worker-brisk-otter", "agentType": "claude-code" },
  "kind": "task | status-update | message-chunk | artifact-update | agent-card | agent-closed",
  "payload": { }
}
```

`payload` holds the corresponding A2A object (Task, Message,
TaskStatusUpdateEvent, Artifact). The `correlationId` is minted once at
chat ingress (in the browser UI) and carried unchanged through every
hop — mirroring round_2's OP-1 invariant — and is displayed in the UI.

### 3.4 Task lifecycle

A2A states: `submitted → working → completed | failed | canceled`
(`input-required` is out of scope for v0.1). The terminal
`status-update` sets `final: true` — no out-of-band terminator is
needed because the stream is durable.

**Status queries are stream replays:** to answer "what is session X
doing?", the ChatOps agent creates an ephemeral ordered consumer on
`a2a.tasks.{id}.events`, replays it, and summarizes. This is demo
purpose #2 falling directly out of the transport.

## 4. Components

All TypeScript / Node 22. Repo layout:

```
protocol/          # SPEC.md + shared lib: types, subjects, envelope, stream setup
agents/chatops/    # ChatOps harness + Dockerfile
agents/worker/     # Worker harness + Dockerfile (shared base image)
web/               # Browser UI (static build) + Dockerfile (static server)
deploy/            # kustomize base + overlays (local, gke)
scripts/           # smoke tests, dev helpers
```

### 4.1 ChatOps agent

A pod running a harness around the **Claude Agent SDK** (headless Claude
Code, one persistent session across chat turns).

- Subscribes to its own inbound task subject: chat turns from the
  browser arrive **as A2A tasks** — the UI delegates a task to the
  `chatops` session exactly the way ChatOps delegates to workers. One
  protocol everywhere.
- Streams its responses as `message-chunk` events on that task's events
  subject; the UI renders them live.
- Custom SDK tools:
  - `delegate_task(prompt, session_hint?)` — generates a session name
    (`worker-<adjective>-<animal>`), creates a worker pod via the k8s
    API, publishes the A2A task request, returns taskId + session name
    immediately (non-blocking).
  - `task_status(taskId | session)` — replays the events stream and
    returns the raw recent events for Claude to summarize.
  - `list_sessions()` — lists worker pods (k8s label selector) joined
    with heartbeat/agent-card state.
- Subscribes to all delegate `*.events` subjects it spawned so it can
  weave final results back into chat proactively (publishing a chat
  `message-chunk` prefixed with the session name when a delegate
  finishes).
- **RBAC:** ServiceAccount + namespace-scoped Role permitting only
  `pods: create, get, list, watch, delete` in `a2a-demo`, plus
  `pods/log: get`. Nothing else.

### 4.2 Worker agent

Same base image, different entrypoint.

- Receives `TASK_ID`, session name, and NATS URL via env (set by
  ChatOps at pod creation).
- Fetches the task request from JetStream, publishes its agent card and
  `working` status, then runs a **one-shot Agent SDK query**.
- Maps SDK stream events onto the protocol: thinking and text deltas →
  `message-chunk`, tool use → `status-update` with metadata, final
  result → `artifact-update` then terminal `completed` (or `failed`)
  status.
- Process exits; pod (restartPolicy `Never`) transitions to
  `Succeeded`/`Failed`. ChatOps garbage-collects completed pods after a
  grace period and publishes `agent-closed`.
- Workers get **no** k8s API access (no ServiceAccount token mounted)
  and for v0.1 run with plain Agent SDK defaults — task prompts for the
  demo are analysis/writing tasks, not arbitrary code execution.

### 4.3 Web UI

Static single-page app; the "server" is only a static file host
(nginx). The browser connects **directly to NATS via WebSocket** using
nats.ws and is just another protocol participant. The WS URL is the
**node-IP + NodePort** form (`ws://10.3.10.<node>:<NodePort>`), never
`localhost` — the browser sits on the LAN, not in the cluster:

- **Chat pane:** sends chat turns as A2A tasks to the chatops session;
  renders streamed chunks. Delegate output is interleaved, prefixed
  with its session name; the correlation ID is visible per exchange.
- **Topology pane:** a live graph driven entirely by real bus traffic —
  no synthetic feed and no k8s API access from the browser. Agent card
  → node appears; heartbeats → node stays fresh; each `message-chunk` /
  `status-update` on a task the ChatOps agent delegated → the
  chatops↔worker edge pulses; terminal status → node greys out;
  `agent-closed` → node fades away. On page load it replays the `A2A`
  stream's recent history to reconstruct current topology.
- Visual design gets the frontend-design treatment during
  implementation — this is a demo for an audience.

## 5. Error handling

- **Worker crash / OOM:** no terminal event appears. `task_status`
  cross-checks pod phase; if the pod is `Failed` (or gone) without a
  final event, ChatOps publishes a synthetic `failed` status-update on
  the task's events subject so the record and the UI converge.
- **Stuck worker:** ChatOps applies an inactivity view — if a task has
  no events for N minutes it reports it as stalled when asked; killing
  it is `delete pod` + synthetic `canceled` status.
- **NATS restart:** JetStream file storage on a PVC preserves streams;
  agents reconnect with standard nats.js reconnect handling.
- **Missing API key:** harness fails fast at startup with a clear log
  line rather than looping.

## 6. Testing

- **Protocol lib:** vitest unit tests — envelope round-tripping, subject
  construction, lifecycle state transitions.
- **M1 smoke test:** `scripts/smoke.ts` runs a fake delegator and fake
  worker as two local processes against the in-cluster NATS (via
  NodePort), proving delegate → stream → replay end-to-end before any
  Claude or k8s API involvement. Observable with the `nats` CLI.
- **E2E:** a scripted chat turn ("summarize X in 3 bullets, delegate
  it") asserting the worker pod appears, chunks stream, terminal state
  lands, and pod completes.

## 7. Milestones

Each is independently demoable; no requirement to finish in one night.

- **M1 — Bus + protocol:** NATS deployed to `a2a-demo`; protocol lib +
  SPEC.md; smoke test passes with two local fake agents.
- **M2 — Real agents in-cluster:** ChatOps + worker images built and
  running; delegation, streaming, status-replay, and GC all working;
  driven via `nats` CLI / smoke scripts.
- **M3 — Web UI:** chat + live topology graph over the NATS WebSocket;
  polish (pulse animations, grey-out/fade lifecycle, correlation IDs).
- **Later (out of scope now):** GKE overlay, Vertex via Workload
  Identity, capability envelope alignment with round_2.
