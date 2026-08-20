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
