# a2a-stream-demo: what it takes to make it real

Author: [@bnaylor]
Date: 2026-08-20
Contributors: rune, claude

## Context

We built [a2a-stream-demo](https://github.com/bnaylor/a2a-stream-demo) in roughly a day to answer one question: can A2A task semantics over NATS JetStream give us delegation with real context, instead of the kanban-card flow where the chat agent has no idea what its workers are doing.  It can.  The demo ran on the homelab cluster and then on a fresh GKE cluster with no changes beyond an overlay, leadership saw it, and the answer came back: build it for real, and productize the UI while we're at it.

This doc is the honest inventory of what "for real" means.  Every shortcut below was taken deliberately and recorded at the time (the PR descriptions on #3 through #7 are the paper trail), so this is a checklist, not archaeology.  Plan of record is to move the code into kube-agents and develop it as a dark, feature-flagged mode - this doc scopes that work, it doesn't design it.

## What exists today

- `a2a-jetstream v0.1` - a small wire protocol (A2A task/status/artifact shapes on JetStream subjects) with a written spec and a shared TS library.  Status queries are stream replays, which is the feature the kanban flow can't do.
- ChatOps agent (sonnet-5) with delegate/status/list tools, proactive result summaries, and prompt-injection fencing on everything worker-authored.  Workers (haiku) are ephemeral pods with a progress-reporting tool and no k8s API access.
- The "mission control" web UI: chat plus a live bus-rail visualization, driven entirely by real bus traffic over a NATS websocket.  Pure-reducer architecture, ~240 tests, and a regression harness that replays captured production bytes.
- An env-neutral kustomize tree (`deploy/base` + local/gke overlays), Cloud Build, and Workload Identity plumbing (currently dormant - see Vertex below).

## The gap, by area

### Security - the big one

The demo's spec says it outright: this must not be presented as the security story.  There isn't one.  The bus is unauthenticated, so publisher identity is a string anyone on the bus can forge.  The agent-side spoof guards and input fencing are real but they trust `from.session` because there is nothing better to trust.

Product needs per-agent NATS credentials with subject-scoped permissions (auth at connect time, per the round_2 recommendation), and the capability envelope from round_2 becomes the authority chain the demo explicitly skipped.  This is the piece that should be designed inside kube-agents rather than bolted on here, since it has to line up with the credential broker and permission model work already in flight.  Biggest single line item - I'd guess O(weeks), not days.

Also in this bucket:

- Ingress is HTTP basic auth over plain port 80.  Fine for a one-day demo IP, disqualifying for product.  TLS + real authn (IAP or SSO), and per-user identity in the envelope instead of everyone being "web".
- Workers currently get `/work` scratch with Write enabled and open egress.  Needs the actual sandboxing story (this is the F9/F10 territory we already know).

### Protocol

v0.1 was invented in one night and it shows in the right ways (small, documented) and the wrong ones (no schema validation at boundaries, no versioning policy beyond "consumers ignore unknown fields").  Two decisions to make early:

- Validate envelopes against schemas at the edges, or keep tolerating garbage by skipping it.  Skipping was correct for a demo; product probably wants both (validate + count).
- Convergence: upstream A2A has moved, and Synadia's NATS agent protocol exists but is not A2A and not JetStream.  Staying a dialect is viable.  Deciding on purpose beats drifting.

### Agent resilience

All known and ledgered, none fixed because none blocked the demo:

- ChatOps is a singleton with `Recreate` strategy - deploys are downtime.  Multi-replica needs inbox partitioning or leader election.
- No per-turn timeout or turn cap on ChatOps - a hung model call freezes the inbox while heartbeats stay green.  A crash of the inbox watcher is similarly silent (the fix is probably just exit-and-let-k8s-restart).
- Workers that die after a ChatOps restart get no terminal event, so they linger as "working" ghosts.
- 24h stream retention was a demo setting.  Product history needs a real policy.

### UI

The architecture is the good news - the reducer is pure, wire-faithful, and heavily tested, so hardening is additive.  The debts: chat/tasks arrays grow without bound and chunk-merging is O(n^2) over a huge replay, fine for an hour and wrong for an ops console.  Multi-user (who else is watching, whose corr ids are whose) doesn't exist.  The reducer trusts every envelope, which is the UI edge of the bus-security item above.

One lesson worth carrying into product development as a rule: the only UI bugs that survived to production were the ones our test harness invented data for.  We now replay captured wire bytes instead - keep doing that.

### Ops

Single-node NATS with a 1Gi PVC, no clustering, no observability beyond `kubectl logs`, and cost controls that amount to a per-task budget env var.  Standard hardening, nothing novel.  The Vertex/WI plumbing is built and dormant; whether product uses Vertex depends on the gke-claude-dev grant question, which I don't expect to move.

## Sequencing (rough)

1. Port into kube-agents behind the feature flag, unchanged - get it building and deploying dark in that repo's process first.
2. Bus security (creds + subject ACLs + envelope identity) before anything else grows on top.  Everything downstream of this is rework if it lands late.
3. Resilience items in parallel - they're small and independent.
4. UI multi-user + bounded state once the identity story exists to build on.
5. Protocol convergence decision - needs a spike on current upstream A2A, ~days.

## Open questions

- Who owns the bus-security design review on the kube-agents side?  It should merge with the existing credential broker work rather than fork it.
- Does product keep the terminal chat client and probe scripts as supported dev tools, or demo-only?
- Model mix and billing for product (the demo runs on my personal key, which is not a plan.)

Next step: carve this into kube-agents issues once the dark-mode port lands.  TBD: owners.
