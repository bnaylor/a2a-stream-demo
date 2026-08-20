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
3. scromp then runs from the laptop: `NATS_URL=nats://10.3.10.4:<nats-client NodePort> npm run smoke`
   → expected output `SMOKE PASS: …`.
