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
