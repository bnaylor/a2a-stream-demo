# a2a-stream-demo

Demo: A2A message semantics over NATS JetStream for ephemeral agent
delegation in Kubernetes. ChatOps agent delegates tasks to ephemeral
worker pods; results stream back live; the durable stream lets the
delegator answer "what is session X doing?" by replay.

- Design spec: `docs/superpowers/specs/2026-08-19-a2a-jetstream-demo-design.md`
- Wire protocol: `protocol/SPEC.md`
- Cluster manifests (kustomize base + local/gke overlays): `deploy/`
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

**6-8 — Longer-running research.** Open-ended questions with several strands
each, so a worker runs for tens of seconds rather than finishing before the
audience has looked up. Good for showing the rail under sustained load, the
thinking twisties filling in, and progress milestones landing on the tap.

```
what's a good place for brunch in Toronto on the weekends that has good parking?
```

```
Suggest options for a long weekend trip for two to the greater Niagara area, including wineries, hiking, entertainment, and dining.  Take mid-September weather into account.
```

```
What are some good options for private insurance in Ontario for a foreign student show is not eligible for OHIP?
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

The `?ws=` override is **required** locally.  Without it the UI dials
same-origin `/ws`, which in the cluster is nginx proxying to the `nats-ws`
Service.  The Vite dev server has no such proxy, so the `you` tap sits on
`link down`.

Type a message and watch it flow:
- Your message echoes back (stream from the client).
- Fake ChatOps chunks render as they arrive.
- Worker delegate lines interleave.
- Pulses travel the rail (visual feedback on the event bus).
- Worker tap appears/greys (ephemeral pod lifecycle).
- Stream counter climbs (event count).
- Tap-click ghost replay runs (session replay).

**Point the dev server at the cluster instead** by overriding the same param.
The `nats-ws` NodePort stays pinned in the local overlay for exactly this
(and for debugging), even though the deployed UI no longer uses it:

```
http://localhost:5173/?ws=ws://10.3.10.3:30222
```

**Live cluster demo:** `kubectl apply -k deploy/overlays/local`, then browse
to `http://10.3.10.3:30080`.  See `deploy/README.md` for the operator's guide.

## GKE

Project `bnaylor-kagents-dev`, cluster `a2a-stream-demo` in
`northamerica-northeast1-a`.  Agents talk to Claude through Vertex in
`us-east5` using Workload Identity, so there's no API key in the cluster.

**Prerequisite:** the Claude models have to be enabled in Vertex Model Garden
for `us-east5` on that project before any of this works.  One-time
click-through in the console, per model.  Without it the agents come up fine
and then 404 on their first turn.

Build and push all three images:

```bash
gcloud builds submit --config cloudbuild.yaml --project bnaylor-kagents-dev .
```

Create the basic-auth secret (once; the web Service is a public
LoadBalancer):

```bash
kubectl -n a2a-demo create secret generic web-htpasswd \
  --from-literal=htpasswd="$(htpasswd -nbB demo 'SOME-PASSWORD')"
```

Deploy, and find the address:

```bash
kubectl apply -k deploy/overlays/gke
kubectl -n a2a-demo get svc web -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

The LB takes a minute or two to get an IP.  Workload Identity bindings and
the rest of the one-time setup are in `deploy/README.md`.
