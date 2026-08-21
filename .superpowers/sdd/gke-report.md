# GKE phase — repo changes

Branch: the `ui-tweaks` worktree (same PR branch as the tweaks commits).
One commit.  Nothing applied, no gcloud run, no push.

## 1.  `deploy/` replaces `pre-gke/`

`pre-gke/` is gone (`git mv` for the manifests, so history follows).

```
deploy/
  README.md
  base/
    kustomization.yaml
    kustomizeconfig/images.yaml
    00-namespace.yaml
    nats-config.yaml  nats-sts.yaml  nats-svc.yaml
    nats-ws-svc.yaml  nats-client-svc.yaml
    chatops-sa.yaml  chatops-role.yaml  chatops-rolebinding.yaml  chatops-deploy.yaml
    worker-sa.yaml
    web-deploy.yaml  web-svc.yaml
    worker-reference.yaml        # not in resources:
  overlays/local/
    kustomization.yaml  nodeports.yaml
  overlays/gke/
    kustomization.yaml  nginx-gke.conf  web-svc-lb.yaml
    workload-identity.yaml  chatops-vertex.yaml  web-auth.yaml
```

Base is environment-neutral: every Service ClusterIP, no NodePorts, image
refs are bare `a2a-demo/chatops`, `a2a-demo/worker`, `a2a-demo/web`.

### The WORKER_IMAGE fieldSpec

The requirement was "local overlay patches NodePorts and nothing else",
but the worker image lives in the chatops `WORKER_IMAGE` env var, which the
built-in `images:` transformer doesn't touch.  Rather than add an env patch
to both overlays, `base/kustomizeconfig/images.yaml` adds a fieldSpec:

```yaml
images:
  - path: spec/template/spec/containers/env/value
    kind: Deployment
```

Overlays inherit `configurations:` from the base (verified empirically —
they do).  Only values that parse as a declared image name get rewritten,
so `CHATOPS_MODEL: claude-sonnet-5` and friends are untouched.  Verified in
the render.

Note also that `configurations:` file paths can't cross the kustomization
root (kustomize refuses `../base/foo.yaml` as a file ref), which is why the
config lives in the base and is inherited rather than referenced.

## Render diff: `deploy/overlays/local` vs the old `pre-gke`

Full `diff -u` of `kubectl kustomize pre-gke` (captured before deletion)
against `kubectl kustomize deploy/overlays/local`:

```diff
--- pregke-render.yaml
+++ local-render.yaml
@@ -6,8 +6,15 @@
   name: a2a-demo
 ---
 apiVersion: v1
+automountServiceAccountToken: false
 kind: ServiceAccount
 metadata:
+  name: a2a-worker
+  namespace: a2a-demo
+---
+apiVersion: v1
+kind: ServiceAccount
+metadata:
   name: chatops
   namespace: a2a-demo
 ---
@@ -98,6 +105,7 @@
 spec:
   ports:
   - name: client
+    nodePort: 30898
     port: 4222
     targetPort: 4222
   selector:
@@ -160,6 +168,7 @@
             secretKeyRef:
               key: ANTHROPIC_API_KEY
               name: a2a-demo-secrets
+              optional: true
         - name: CHATOPS_MODEL
           value: claude-sonnet-5
         - name: WORKER_IMAGE
```

Every line accounted for:

1. **New `a2a-worker` ServiceAccount** with `automountServiceAccountToken:
   false`.  Intended (deliverable 1).  No Role or RoleBinding for it, so it
   grants nothing.
2. **`nodePort: 30898` on `nats-client`.**  `pre-gke` declared the Service
   `type: NodePort` with no pin, so the apiserver auto-assigned; the live
   cluster landed on 30898 and that got baked into every runbook.  The local
   overlay now pins it explicitly.  Same value, now deterministic.
3. **`optional: true` on the API key secretKeyRef.**  Intended, so the pods
   also start on GKE where no `a2a-demo-secrets` exists.

Nothing else moved.  The anticipated "web image tag reference styling"
delta didn't materialize: base uses `a2a-demo/web:latest` and the overlay
sets `newName` only, so the rendered string is byte-identical to the old
hardcoded `10.3.10.52:5000/a2a-demo/web:latest`.  Same for chatops and for
the `WORKER_IMAGE` env value.

The `nats-ws` and `web` NodePorts (30222 / 30080) were already pinned in
`pre-gke`, so they don't show in the diff — the overlay re-pins them to the
same values.

## GKE overlay

- Images → `northamerica-northeast1-docker.pkg.dev/bnaylor-kagents-dev/a2a-demo/*`
  (all three, plus `WORKER_IMAGE` via the fieldSpec above).
- `web` Service → `type: LoadBalancer`, port 80.
- `iam.gke.io/gcp-service-account:
  a2a-demo-agents@bnaylor-kagents-dev.iam.gserviceaccount.com` on both the
  `chatops` and `a2a-worker` KSAs.
- ChatOps env += `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION=us-east5`,
  `ANTHROPIC_VERTEX_PROJECT_ID=bnaylor-kagents-dev`.
- `configMapGenerator` builds `web-nginx-gke` from `nginx-gke.conf` (key
  `default.conf`).  Hash-suffixed, and kustomize rewrites the volume ref in
  the patched Deployment — verified in the render
  (`web-nginx-gke-822cd99g82`), so a config edit rolls the pods.
- web Deployment mounts that ConfigMap at
  `/etc/nginx/conf.d/default.conf` (subPath) and Secret `web-htpasswd` at
  `/etc/nginx/htpasswd` (subPath `htpasswd`), both readOnly.
- `web-htpasswd` is created out-of-band and never committed.  Documented in
  both READMEs with the `htpasswd -nbB` one-liner.

## 2.  Vertex support in the agents

New `agents/common/src/model-auth.ts`:

```ts
export const VERTEX_ENV_KEYS = ["CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION",
                                "ANTHROPIC_VERTEX_PROJECT_ID"] as const;
export function missingModelAuthEnv(env): string[]
```

Pure function, 6 tests.  Both `agents/worker/src/main.ts` and
`agents/chatops/src/main.ts` now call it instead of
`need("ANTHROPIC_API_KEY")`: an API key is required unless
`CLAUDE_CODE_USE_VERTEX === "1"`, in which case region and project are
required instead.  Only the literal `"1"` counts as enablement.

`agents/chatops/src/k8s.ts`:

- `WORKER_SERVICE_ACCOUNT = "a2a-worker"` on the generated pod spec,
  `automountServiceAccountToken: false` kept.
- `PASSTHROUGH_ENV_KEYS` (= `VERTEX_ENV_KEYS`) copied from
  `cfg.passthroughEnv` when set; `main.ts` passes `process.env`.  Same
  shape as the existing `workerModel` handling, just list-driven.
- `ANTHROPIC_API_KEY` secretKeyRef → `optional: true`.

New `agents/chatops/src/k8s.test.ts`, 4 tests: SA name + no token mount,
optional secret, Vertex passthrough present (and unrelated env not copied),
Vertex env absent when ChatOps has none.

`deploy/base/worker-reference.yaml` updated to match (SA name, optional
secret, note about the passthrough).

## 3.  Same-origin `/ws`

`web/nginx.conf` gains the `/ws` proxy to `http://nats-ws:9222` with the
upgrade headers and 1h read/send timeouts.  `web/src/config.ts` now
defaults to `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
`?ws=` override unchanged.  New `web/src/config.test.ts`, 5 tests
(default, host-with-port, https→wss, two override forms).

The gke ConfigMap carries a byte-identical `/ws` block.  Both files say to
keep them in sync.

Root README's "?ws= is required locally" paragraph rewritten — it used to
explain the 30222 NodePort default.  The NodePort itself stays pinned in
the local overlay for direct/debug access, documented as such in both
READMEs.

## 4.  `cloudbuild.yaml`

Repo root.  Three `gcr.io/cloud-builders/docker` build steps (worker and
chatops via `-f agents/Dockerfile --target=…`, web via `-f
web/Dockerfile`), context `.` for all three.  `_AR` substitution holds the
registry path.  Each image tagged `:latest` and `:$SHORT_SHA`; all six refs
in `images:`.  `timeout: 1800s`, `logging: CLOUD_LOGGING_ONLY`.

`.dockerignore` had `pre-gke` in it; changed to `deploy`.

## 5.  Docs

- `deploy/README.md` — replaces `pre-gke/README.md`.  Keeps the environment
  facts (both homelab and GKE) and the M1/M2/M3 handoff history, adds the
  migration note ("apply path is now `kubectl apply -k
  deploy/overlays/local`"), the layout, the WORKER_IMAGE fieldSpec
  explanation, the GKE prerequisites (WI bindings, htpasswd Secret, Model
  Garden), and the `/ws` proxy story.
- Root README — `deploy/` in the links list, corrected local-dev `?ws=`
  paragraph, and a new **GKE** section: `gcloud builds submit`, the
  htpasswd one-liner, `kubectl apply -k deploy/overlays/gke`, the LB IP
  lookup, and the Model Garden prerequisite.

## Verification

Render only.  Nothing applied, no gcloud invoked.

| Check | Result |
| --- | --- |
| `kubectl kustomize deploy/base` | clean |
| `kubectl kustomize deploy/overlays/local` | clean |
| `kubectl kustomize deploy/overlays/gke` | clean |
| `npx vitest run agents/chatops` | 19 passed (2 files) |
| `npm run -w web test` | 178 passed (7 files) |
| `npm test` (root) | 55 passed, 4 skipped |
| `npm run typecheck` | clean |
| `npm run typecheck:web` | clean |
| `npm run -w web build` | green |

Root was 45/4 before; +6 model-auth, +4 k8s = 55/4.

## Concerns

- **Model IDs under Vertex.**  Both agents still default to
  `claude-sonnet-5`.  Vertex model IDs are usually versioned
  (`claude-sonnet-4-5@20250929` style), so `CHATOPS_MODEL` /
  `WORKER_MODEL` may need overriding in the gke overlay once we see what
  Model Garden exposes in `us-east5`.  Left alone deliberately — guessing
  the string is worse than a one-line patch after the first real run.
- **Untested against a live cluster.**  Everything here is render- and
  unit-verified.  The Workload Identity path, the basic-auth WebSocket
  upgrade, and the LoadBalancer have not been exercised.
- **`passthroughEnv: process.env`** hands ChatOps' whole environment to
  `workerPodManifest`.  The key list is what constrains it, and there's a
  test asserting unrelated keys aren't copied, but it's worth remembering
  if that list ever grows.
- **The `/ws` block is duplicated** between `web/nginx.conf` and
  `deploy/overlays/gke/nginx-gke.conf`.  Comments in both point at each
  other.  Not worth a templating layer for six lines.
- **Basic auth over plain HTTP.**  The GKE LoadBalancer is port 80, so the
  password crosses the wire in base64.  Fine for a demo IP that lives for a
  day; if it stays up, it wants a managed cert and an Ingress.
- `docs/superpowers/specs/…` and the M3 plan still reference `pre-gke/`.
  Left as-is — they're dated design artifacts, not live docs.
