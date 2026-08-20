# deploy — kustomize base + overlays

Cluster manifests for the A2A demo.  Two targets: the homelab microk8s
cluster and a GKE cluster running the agents on Vertex.

```bash
kubectl apply -k deploy/overlays/local   # homelab (microk8s)
kubectl apply -k deploy/overlays/gke     # GKE + Vertex
```

**Migration note (rune):** this replaces the old throwaway `pre-gke/`
directory.  The apply path is now `kubectl apply -k deploy/overlays/local`.
Same manifests, same pinned NodePorts, same namespace.  `kubectl apply -k
pre-gke/` no longer exists.

**Apply only from a machine whose kubectl context is the cluster you mean.**
bnaylor's corp laptop defaults to a GKE context, so `kubectl config
current-context` first.  That warning is why the two overlays are separate
directories rather than one parameterized thing.

**No secrets in here.**  `ANTHROPIC_API_KEY` and the web basic-auth htpasswd
both live in k8s Secrets created out-of-band.

## Layout

- `base/` — everything, environment-neutral.  All Services are ClusterIP, no
  NodePorts, and image references carry no registry prefix (`a2a-demo/web`
  and friends).  Namespace is `a2a-demo`; nothing cluster-scoped beyond the
  Namespace object itself.
- `overlays/local/` — the in-cluster registry prefix plus the three pinned
  NodePorts.
- `overlays/gke/` — Artifact Registry image refs, a LoadBalancer for the UI
  behind HTTP basic auth, Workload Identity annotations, and Vertex env on
  ChatOps.
- `base/worker-reference.yaml` — the shape ChatOps builds worker pods from
  (see `agents/chatops/src/k8s.ts`).  Deliberately not in `resources:`; it is
  documentation, not a manifest to apply.

### The WORKER_IMAGE trick

ChatOps creates worker pods itself, so the worker image isn't a container
image anywhere in these manifests.  It's the `WORKER_IMAGE` env var on the
chatops Deployment, which the `images:` transformer wouldn't normally touch.
`base/kustomizeconfig/images.yaml` adds a fieldSpec for that env value, so
each overlay sets its registry once in `images:` and the worker ref follows.
Overlays inherit the config from the base.

Only values that parse as one of the declared image names get rewritten, so
other env vars are safe.

## Environment facts

**Homelab (verified against the live cluster):**

- microk8s, nodes `dusty` 10.3.10.4 / `lucky` 10.3.10.2 / `ned` 10.3.10.3,
  containerd.
- Registry `10.3.10.52:5000` (aka `registry.naylo.rs`), plain HTTP/insecure.
  Use the IP form; the nodes' containerd is already configured for it.
- LAN access is NodePort, not LoadBalancer: the MetalLB pool
  `10.3.10.50–60` is nearly full (only `.60` free).
- Pinned NodePorts: `nats-client` 30898, `nats-ws` 30222, `web` 30080.

**GKE:**

- Project `bnaylor-kagents-dev`, cluster `a2a-stream-demo`, zone
  `northamerica-northeast1-a`.
- Artifact Registry
  `northamerica-northeast1-docker.pkg.dev/bnaylor-kagents-dev/a2a-demo`,
  images `chatops` / `worker` / `web`.  Built by `cloudbuild.yaml` at the
  repo root.
- Google service account
  `a2a-demo-agents@bnaylor-kagents-dev.iam.gserviceaccount.com`, Workload
  Identity pool `bnaylor-kagents-dev.svc.id.goog`.
- Vertex region for the agents is `us-east5` (regional endpoint), not the
  cluster's region.  That's where the Claude models are enabled.

## GKE prerequisites

Three things exist outside kustomize.

**1.  Workload Identity bindings.**  Both KSAs (`chatops` and `a2a-worker`)
impersonate the same GSA:

```bash
for ksa in chatops a2a-worker; do
  gcloud iam service-accounts add-iam-policy-binding \
    a2a-demo-agents@bnaylor-kagents-dev.iam.gserviceaccount.com \
    --project bnaylor-kagents-dev \
    --role roles/iam.workloadIdentityUser \
    --member "serviceAccount:bnaylor-kagents-dev.svc.id.goog[a2a-demo/${ksa}]"
done
```

The GSA needs `roles/aiplatform.user` on the project, and the Claude models
have to be enabled in Vertex Model Garden for `us-east5` first.  Model
Garden enablement is a one-time click-through in the console, per model.

**2.  The htpasswd Secret.**  The GKE web Service is a public LoadBalancer,
so nginx sits in front with basic auth.  Never committed:

```bash
kubectl -n a2a-demo create secret generic web-htpasswd \
  --from-literal=htpasswd="$(htpasswd -nbB demo 'SOME-PASSWORD')"
```

`htpasswd` comes from `apache2-utils` / `httpd-tools`.  `-B` is bcrypt.

**3.  Nothing else.**  There's deliberately no `a2a-demo-secrets` on GKE —
auth is Vertex via Workload Identity, and the `ANTHROPIC_API_KEY`
`secretKeyRef` is marked `optional: true` in the base so the pods start
anyway.

## The /ws proxy

The browser's WebSocket is same-origin: the UI dials `/ws` on whatever host
served the page, and the web pod's nginx proxies that to the `nats-ws`
Service.  One port, follows the page's scheme, and on GKE the upgrade
request carries the Authorization header the browser already has.

`nats-ws` keeps its 30222 NodePort in the local overlay for direct/debug
access (`?ws=ws://10.3.10.3:30222` still works), but the UI no longer needs
it.

The GKE overlay swaps the image's nginx config for a ConfigMap
(`web-nginx-gke`, from `overlays/gke/nginx-gke.conf`) that adds the basic
auth.  The `/ws` block in it is a copy of the one in `web/nginx.conf`.  If
you change one, change both.

## Handoff history

Kept for the record.  These ran against the homelab cluster with the old
`pre-gke/` path; substitute `deploy/overlays/local`.

### M1 (rune)

1. Apply; expected ready: `nats-0` running.  `chatops`/`web` ImagePullBackOff
   until M2/M3 — that's fine.
2. Report `kubectl -n a2a-demo get svc nats-client nats-ws web -o wide`.
3. Smoke test from a box with node + `tsx` (rune's build box has it, scromp's
   corp laptop can't `npm install tsx`):
   `NATS_URL=nats://10.3.10.<node>:30898 npm run smoke`.

   **Verified 2026-08-19:** rune ran it against `nats://10.3.10.3:30898` →
   `SMOKE PASS … 6 events streamed live and replayed cold`.  M1 complete.

### M2 (rune)

1. Create the API key secret (once, never committed):
   `kubectl -n a2a-demo create secret generic a2a-demo-secrets --from-literal=ANTHROPIC_API_KEY=sk-...`
2. Build + push from repo root:
   `docker build --target worker  -t 10.3.10.52:5000/a2a-demo/worker:latest  -f agents/Dockerfile . && docker push 10.3.10.52:5000/a2a-demo/worker:latest`
   `docker build --target chatops -t 10.3.10.52:5000/a2a-demo/chatops:latest -f agents/Dockerfile . && docker push 10.3.10.52:5000/a2a-demo/chatops:latest`
3. Apply, then `kubectl -n a2a-demo rollout restart deploy chatops`.
4. Verify: chatops pod Running, startup logs; then
   `NATS_URL=nats://10.3.10.4:30898 npx tsx scripts/chat.ts` and delegate a
   task.  Worker pod should appear and complete; asking about the session
   should get a summary from replay.

### M3 (rune — audience-facing)

1. `docker build -t 10.3.10.52:5000/a2a-demo/web:latest -f web/Dockerfile . && docker push 10.3.10.52:5000/a2a-demo/web:latest`
2. Apply, then `kubectl -n a2a-demo rollout status deploy web`.
3. Browser to **`http://10.3.10.3:30080`** (any node IP works).
   **Preflight:** if the page was open before chatops started, reload once —
   the rail's `you` tap should read `websocket`, not `connecting` or `link
   down`.  Taps from earlier rehearsals reappear; the UI replays the last 24h
   of the stream on load, by design.
4. No tooling needed on the demo machine, just a browser.  The `tsx`/node
   requirement applies only to the M1 dev smoke.
