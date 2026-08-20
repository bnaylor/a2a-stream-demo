# pre-gke — throwaway local manifests

Scratch space for the homelab (microk8s) iteration of the A2A demo,
before any GKE overlay exists.

**Why this exists:** rune builds/pushes the demo images and iterates on
the k8s manifests. Committing them here lets rune and scromp transfer
files and review fixes via git instead of scp.

**Rules:**

- **No secrets.** `ANTHROPIC_API_KEY` (and anything else sensitive) lives
  in a k8s Secret created out-of-band — never committed here.
- This is **throwaway**. Once `deploy/overlays/gke` (or a proper
  `deploy/base` + `deploy/overlays/local` tree) exists, this directory
  is deleted.
- Everything is namespaced `a2a-demo`; no cluster-scoped resources
  beyond the `a2a-demo` Namespace object itself (`00-namespace.yaml`).
- **Apply only from a machine whose kubectl context is the microk8s
  cluster.** bnaylor's corp laptop defaults to a GKE context
  (`bnaylor-ka-test`) — `kubectl apply -k pre-gke/` from there would
  deploy to the wrong cluster. Check `kubectl config current-context`
  first.

**Environment facts (verified against the live cluster):**

- Cluster: microk8s, nodes `dusty` 10.3.10.4 / `lucky` 10.3.10.2 /
  `ned` 10.3.10.3, containerd.
- Image registry: `10.3.10.52:5000` (a.k.a. `registry.naylo.rs`), plain
  HTTP/insecure — use the IP form.
- LAN reachability: NodePort (MetalLB pool `10.3.10.50–60` is nearly
  full; only `.60` free).

## M1 handoff (rune)

1. `kubectl apply -k pre-gke/` (from a microk8s-context machine — see warning above).
   Expected ready: `nats-0` running; `chatops`/`web` will ImagePullBackOff (images land in M2/M3 — that's fine).
2. Report back (commit to this README or PR comment):
   - `kubectl -n a2a-demo get svc nats-client nats-ws web -o wide` → the assigned NodePorts.
3. **Smoke test** — run from a machine that has node + `tsx` installed
   (rune's build box does; scromp's corp laptop does not — it blocks
   `npm install` of `tsx`). Do NOT assume the laptop can run it:
   `NATS_URL=nats://10.3.10.<node>:<nats-client NodePort> npm run smoke`
   → expected output `SMOKE PASS: …`.

   **Verified 2026-08-19:** rune ran the smoke against the live cluster
   (`nats://10.3.10.3:30898`) → `SMOKE PASS … 6 events streamed live and
   replayed cold`. M1 is complete.

   **M3 note (audience-facing):** the browser UI needs no tooling on the
   demo machine — the manager just opens a browser to the `web` NodePort.
   The `tsx`/node requirement applies only to the M1 dev smoke, never to
   the audience.

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
