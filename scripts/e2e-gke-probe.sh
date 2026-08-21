#!/bin/bash
# Throwaway E2E probe: send one chat line to the GKE bus via port-forward,
# keep stdin open long enough to collect streamed replies, then exit.
set -u
PROMPT="${1:?usage: e2e-gke-probe.sh \"prompt\" [hold-seconds]}"
HOLD="${2:-150}"
( echo "$PROMPT"; sleep "$HOLD" ) | NATS_URL=nats://127.0.0.1:14222 npx tsx scripts/chat.ts
