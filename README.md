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

### Chat from a dev box

Run a terminal chat client against the live cluster:

```bash
NATS_URL=nats://10.3.10.3:30898 npx tsx scripts/chat.ts
```

Type prompts; the chatops agent (running in the cluster) will reply, optionally delegating to worker pods. 
Messages from the cluster stream back live, prefixed by session name (e.g. `[otter]`).
Ctrl-D to exit.

## Demo prompts

Copy-paste these into the chat client in order. Worker sessions are named after
short animals (`otter`, `lynx`, `wren`, …) — ChatOps tells you which one it
spawned, and you refer back to it by that name.

**1 — Delegated research with WebFetch.** The bread-and-butter beat: one turn,
one worker pod, live output streaming back.

```
Fetch the A2A protocol spec and Synadia's agent-messaging write-up, then give me a gap analysis: which A2A concepts have no clean NATS equivalent, and which NATS primitives A2A leaves on the table.
```

**2 — Multi-source research.** Shows a worker running long enough to report
several progress milestones.

```
Research current best practices for JetStream stream retention and give me a recommendation for a work-queue-style agent event log. Cite at least three sources.
```

**3 — Interleaving.** Two units of work in one turn: ChatOps answers the trivial
half itself and delegates the expensive half, so you see a fast local reply
while a pod spins up behind it.

```
Two things: write me a haiku about message buses, and separately kick off that A2A-vs-NATS gap analysis as a delegated task.
```

**4 — Mid-flight status (the durability beat).** Run this *while* a worker from
prompt 1-3 is still going; substitute the session name ChatOps gave you. The
answer is reconstructed by replaying the durable stream, not by holding a
connection open.

```
What is otter doing right now?
```

**5 — No-network fallback.** Use this if the venue Wi-Fi dies or WebFetch is
blocked — it needs no outbound network, and it exercises the worker's `/work`
scratch directory.

```
Delegate this: write a one-page design memo arguing for durable event streams over point-to-point RPC for agent-to-agent messaging. Draft it three times in your scratch directory, critiquing your own previous draft in writing each time, then give me the final draft plus the critiques.
```

## Demo (browser)

**Local development:** start a dev NATS server (with JetStream and WebSocket), run the fake ChatOps agent, and the Vite dev server:

```bash
# Terminal A: start NATS with JetStream + WebSocket
scripts/dev-ws.sh

# Terminal B: run the fake ChatOps agent
NATS_URL=nats://127.0.0.1:4348 npx tsx scripts/fake-chatops.ts

# Terminal C: start the web UI
npm run -w web dev
```

Then open:

```
http://localhost:5173/?ws=ws://127.0.0.1:9222
```

The `?ws=` override is **required** locally. Without it the UI dials
`ws://localhost:30222` — the cluster's NodePort, which nothing is listening on
during local dev — and the `you` tap will sit on `link down`.

Type a message and watch it flow:
- Your message echoes back (stream from the client).
- Fake ChatOps chunks render as they arrive.
- Worker delegate lines interleave.
- Pulses travel the rail (visual feedback on the event bus).
- Worker tap appears/greys (ephemeral pod lifecycle).
- Stream counter climbs (event count).
- Tap-click ghost replay runs (session replay).

**Point the dev server at the cluster instead** by overriding the same param:

```
http://localhost:5173/?ws=ws://10.3.10.3:30222
```

**Live cluster demo:** see `pre-gke/README.md` (M3 handoff section) for the operator's guide to deploying and running the demo on the microk8s cluster.
