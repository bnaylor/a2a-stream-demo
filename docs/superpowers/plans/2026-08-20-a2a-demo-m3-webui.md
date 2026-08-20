# A2A Demo M3 — Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The audience-facing UI: a browser page (served from the cluster) with a full-width **NATS bus rail** visualization on top and the chat pane below — every message a pulse on the rail, workers tapping in and out live, chat and topology driven entirely by real bus traffic over the NATS WebSocket.

**Architecture:** Static SPA (Vite + React + TS) served by nginx. The browser connects straight to NATS via `nats.ws` and is just another protocol participant: on load it replays the `A2A` stream to reconstruct topology, then consumes live. One pure reducer turns envelopes into UI state (agents, tasks, chat entries, pulse queue) — fully unit-testable with no WebSocket. Chat input publishes A2A tasks addressed `to: chatops` using the protocol package's pure modules (envelope/subjects/ids are node-free; only the JetStream calls are reimplemented thinly over `nats.ws`).

**Layout (bnaylor-approved "mission control"):** top ~45%: horizontal glowing rail labeled NATS JETSTREAM; taps for `you · websocket` (left), `chatops`, and each live worker; pulses travel along the rail colored by correlationId; stream counter + replay indicator on a footer line of the panel. Bottom: chat transcript (chatops bare, `[session]`-prefixed delegate lines, `[progress]` styled distinctly, corr-id chip per exchange matching pulse color) + input.

**Tech Stack:** Vite 5, React 18, TypeScript strict, `nats.ws` ^1.x, vitest. No chart/graph libraries — the rail is hand-rolled SVG + rAF (fixed layout math, not force-directed).

**Spec:** `docs/superpowers/specs/2026-08-19-a2a-jetstream-demo-design.md` §4.3; wire contract `protocol/SPEC.md`.

## Global Constraints

- The browser is a **read-mostly protocol participant**: it publishes ONLY chat task submissions (`a2a.tasks.{id}.request` with `to: {session: "chatops"}`); it never publishes events, cards, or heartbeats.
- All UI state derives from bus traffic — no k8s API, no backend endpoints. The web pod is nginx serving static files, nothing else.
- Reuse `@a2a-demo/protocol`'s pure modules (`envelope`, `subjects`, `ids`, `types`) in the browser; do NOT import its `client.ts`/`stream.ts`/`heartbeat.ts` (they type against the node `nats` package). The web bus layer reimplements the few JetStream calls it needs over `nats.ws`.
- Pulse/lifecycle semantics: live envelope → one pulse from the publisher's tap along the rail (toward the `you` tap; submissions travel from `you` toward chatops). Replayed history renders state but NEVER animates pulses. agent-card → tap appears; terminal status → worker tap greys; agent-closed → tap detaches and fades. Heartbeats (core NATS `agents.hb.>`) → soft ripple on that tap; no heartbeat for >45 s → tap dims. Clicking a worker tap ghost-replays that task's events (dim pulses + a small timeline) — the "status is a stream replay" beat, interactive.
- NodePorts get PINNED in this milestone: `nats-ws` → 30222, `web` → 30080 (the auto-assigned WS port was never reported/used; the pinned values become canonical). The UI's default WS URL is `ws://${location.hostname}:30222`, overridable via `?ws=` query param. `nats-client` (30898) stays untouched.
- Unit tests: reducer + chat-submit builder run in vitest with zero network. No test ever needs an API key. Browser E2E is manual (a scripted local check against `nats-server --js` with WS enabled + `scripts/fake-chatops.ts`).
- Visual work (Task 4) MUST invoke the `frontend-design:frontend-design` skill before styling; aesthetic direction: dark "mission control" — near-black background, rail as the single luminous element, restrained monospace-adjacent type for labels, color used almost exclusively for correlation identity and lifecycle state. No default-Bootstrap look, no gradients-everywhere.
- TypeScript strict; `"./file.ts"` import style consistent with the repo; every new file lives under `web/`.
- NEVER `kubectl apply` from this laptop (GKE context hazard); manifest verification is `kubectl kustomize` render only.

---

### Task 1: Web workspace scaffold

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/config.ts`
- Modify: root `package.json` (workspaces gains `"web"`), root `tsconfig.json` include gains `"web/src"` — NOTE: web has its own tsconfig for DOM libs; root include addition is NOT wanted if it breaks node typecheck. Preferred: leave root tsconfig alone and give web its own `typecheck:web` script (`tsc -p web --noEmit`); add root script `"typecheck:web": "tsc -p web --noEmit"`.

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run -w web dev` serves the app; `npm run -w web build` emits `web/dist`; `npm run typecheck:web` clean. `config.ts` exports `wsUrl(): string` — `?ws=` param else `ws://${location.hostname}:30222`.

- [ ] **Step 1: Write the files.** `web/package.json`: name `@a2a-demo/web`, private, type module, scripts `dev`/`build`/`preview`/`test` (vitest), deps `react@^18`, `react-dom@^18`, `nats.ws@^1.19`, `@a2a-demo/protocol": "*"`, devDeps `vite@^5`, `@vitejs/plugin-react@^4`, `typescript`, `vitest`, `@types/react`, `@types/react-dom`. `web/tsconfig.json`: extends nothing; ES2022/bundler/strict/jsx react-jsx/lib DOM+ES2022; include `src`. `vite.config.ts`: react plugin, `build.outDir: "dist"`. `index.html` + `main.tsx` + `App.tsx`: minimal shell rendering "a2a demo" placeholder split into two stacked panels (topology zone / chat zone) with the 45/55 split. `config.ts`:

```ts
export function wsUrl(): string {
  const param = new URLSearchParams(window.location.search).get("ws");
  return param ?? `ws://${window.location.hostname}:30222`;
}
```

- [ ] **Step 2: Verify.** `npm install` at root; `npm run -w web build` succeeds; `npm run typecheck:web` clean; root `npm test` still green (web has no tests yet — ensure vitest config doesn't pick up web/dist).
- [ ] **Step 3: Commit** `feat(m3): scaffold web workspace (vite + react + nats.ws)`.

---

### Task 2: Bus layer + pure reducer (the UI's brain)

**Files:**
- Create: `web/src/model.ts` (state types + reducer), `web/src/bus.ts` (nats.ws plumbing), `web/src/submit.ts` (chat task builder)
- Test: `web/src/model.test.ts`, `web/src/submit.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `parseEnvelope`, `makeEnvelope`, id/subject helpers from `@a2a-demo/protocol` (pure modules only).
- Produces:
  - `model.ts`: `UiState { agents: Map<string, AgentView>; tasks: Map<string, TaskView>; chat: ChatEntry[]; pulses: Pulse[]; streamMsgCount: number }`; `AgentView { session, agentType, status: "live"|"stale"|"done"|"closed", lastHeartbeat?: number, statusLine?: string }`; `TaskView { taskId, contextId, correlationId, to?: string, state: TaskState, owner: string /* publishing session */ }`; `ChatEntry { id, kind: "user"|"chatops"|"delegate"|"progress", session?: string, text, correlationId }`; `Pulse { id, fromSession, correlationId, kind: EnvelopeKind, at: number }`.
  - `reduce(state, event: BusEvent): UiState` — pure. `BusEvent = { type: "envelope", env: Envelope, live: boolean } | { type: "heartbeat", session: string, at: number } | { type: "tick", now: number }`.
  - Reducer rules (each one a test): agent-card adds/refreshes agent; agent-closed → status closed; heartbeat updates lastHeartbeat, tick past 45 s → stale; message-chunk from chatops → append/merge streaming chatops ChatEntry (merge consecutive chunks of same taskId into one entry); message-chunk from a worker → delegate entry (`[progress] ` prefix ⇒ kind progress, statusLine updated on the agent); status-update terminal → task state + agent status done; artifact-update recorded on task; submissions (`kind: "task"` with `to.session === "chatops"`) → user ChatEntry; live envelopes (and ONLY live) also push a `Pulse` (pulses array capped at 200); `streamMsgCount` increments on every envelope incl. replayed.
  - `bus.ts`: `startBus(url: string, dispatch: (e: BusEvent) => void): Promise<BusHandle>`; `BusHandle { publishChat(text: string): Promise<{taskId: string, correlationId: string}>; close(): Promise<void> }`. Behavior: connect via nats.ws; ordered consumer deliverAll on `a2a.>` — events replay with `live: false` until initial pending drains, then `live: true` (snapshot the stream's last sequence via jetstreamManager `streams.info("A2A")` at connect; messages at or below that sequence are replay. Use the literal stream name `"A2A"` — the protocol package's `STREAM_NAME` lives in `stream.ts`, which is node-only and must not be imported in the browser); core subscription `agents.hb.>` → heartbeat events; a 5 s `setInterval` dispatching tick. `publishChat` builds via `submit.ts` and js-publishes to the request subject.
  - `submit.ts`: `buildChatTask(text: string): {env: Envelope, taskId: string, correlationId: string}` — pure, mirrors `scripts/chat.ts` (to chatops, payload prompt + submitted status, fresh ids). Unit-tested (shape, to-addressing, id prefixes).

- [ ] **Step 1: Write failing tests** for every reducer rule above (table-style; construct envelopes with `makeEnvelope`) and for `buildChatTask`. Include: replayed envelope produces NO pulse but counts in `streamMsgCount`; consecutive chatops chunks merge; `[progress] ` chunk sets agent statusLine and kind progress; tick marks stale at >45 s and not at 44 s; pulse cap at 200.
- [ ] **Step 2:** `npm run -w web test` → fail (modules missing).
- [ ] **Step 3: Implement** `model.ts`, `submit.ts` fully; `bus.ts` (not unit-tested — exercised in the manual E2E; must typecheck).
- [ ] **Step 4:** tests pass; `npm run typecheck:web` clean; root `npm test` untouched.
- [ ] **Step 5: Commit** `feat(m3): bus layer, pure envelope reducer, chat task builder`.

---

### Task 3: Chat pane

**Files:**
- Create: `web/src/Chat.tsx`
- Modify: `web/src/App.tsx` (wire store: `useReducer(reduce, initialState)` + `startBus` in an effect, context or props down)
- Test: `web/src/Chat.test.tsx` (rendering-level via vitest + @testing-library/react — add devDeps `@testing-library/react`, `jsdom`, configure vitest environment jsdom for `.test.tsx` only)

**Interfaces:**
- Consumes: `UiState.chat`, `BusHandle.publishChat`.
- Produces: transcript list (auto-scroll pinned to bottom unless user scrolled up), entries rendered by kind: user (right-aligned or prompt-prefixed `you>`), chatops (plain), delegate (`[otter]` prefix, session-colored), progress (dimmer, `⏳` glyph); every entry shows nothing per-line for corr, but each exchange group gets one small corr-chip whose color = correlation color (deterministic hash corrId → hue; export `corrColor(corrId): string` from `model.ts` so Task 4 reuses it). Input row: text field + Enter submits via `publishChat`, optimistic user entry (reducer already adds it when the submission envelope echoes back from the stream — so DON'T double-add; optimistic entry only if echo latency proves annoying in E2E, decide then and note it).

- [ ] **Step 1:** failing render tests: given a state with the four entry kinds, the transcript shows `you>`, bare chatops text, `[otter]` prefix, progress styling class; typing + Enter calls `publishChat` with the text.
- [ ] **Step 2:** fail → **Step 3:** implement → **Step 4:** pass + typecheck → **Step 5: Commit** `feat(m3): chat pane with session prefixes and correlation chips`.

---

### Task 4: The rail (topology panel) — visual centerpiece

**Files:**
- Create: `web/src/Rail.tsx`, `web/src/rail-layout.ts` (pure tap-position math, unit-testable), `web/src/styles.css`
- Modify: `web/src/App.tsx`
- Test: `web/src/rail-layout.test.ts`

**Interfaces:**
- Consumes: `UiState.agents/tasks/pulses/streamMsgCount`, `corrColor`.
- Produces: the mission-control panel per the approved mock:
  - Horizontal rail (SVG line w/ subtle glow) labeled `NATS JETSTREAM`; fixed taps: `you · websocket` leftmost, `chatops` next; worker taps allocated left-to-right in arrival order (`rail-layout.ts: layoutTaps(agents, width): TapPosition[]` — pure, tested: stable ordering, spacing, overflow compression when >6 workers).
  - Pulse animation: rAF loop; each `Pulse` animates a dot from its tap along the rail toward the `you` tap (submissions animate you→chatops); duration ~900 ms; color `corrColor(correlationId)`; size by kind (artifact-update largest, status-update small, message-chunk tiny). Consume from `state.pulses` by id watermark — do not mutate reducer state from the animation loop.
  - Lifecycle rendering: worker tap slides in on agent-card; statusLine under the name (`⏳ fetching spec 2/2`); terminal → greyed `done`; agent-closed → detach + fade out over ~2 s then removed from layout; stale (no heartbeat 45 s) → dimmed with a `?`; heartbeat → soft ripple ring on the tap.
  - Footer line of the panel: `A2A stream · {streamMsgCount} msgs · 24h` plus, while a ghost replay runs, `▓▓░ replaying {corrId-short}`.
  - Ghost replay: clicking a worker tap replays that worker's task events from `state` (they're already in memory — no re-fetch): dim colorless pulses re-run in sequence (~120 ms apart) plus a transient timeline strip (kind + state labels) under the rail; demo purpose #2 made clickable.
- **Process requirement:** the implementer MUST invoke the `frontend-design:frontend-design` skill before writing `styles.css`/visual code, with the aesthetic direction from Global Constraints, and note in the report what direction it chose.

- [ ] **Step 1:** failing tests for `rail-layout.ts` (positions, ordering, compression).
- [ ] **Step 2:** fail → **Step 3:** implement layout math, then Rail component + styles (frontend-design invoked) → **Step 4:** layout tests pass, `typecheck:web` clean, `npm run -w web build` succeeds → **Step 5: Commit** `feat(m3): NATS bus rail — taps, pulses, lifecycle, ghost replay`.

---

### Task 5: Ship it — image, manifests, local E2E, handoff

**Files:**
- Create: `web/Dockerfile`, `web/nginx.conf`, `scripts/dev-ws.sh`
- Modify: `pre-gke/nats-ws-svc.yaml` (pin `nodePort: 30222`), `pre-gke/web-svc.yaml` (pin `nodePort: 30080`), `pre-gke/README.md` (M3 handoff), root `README.md` (browser instructions)

**Interfaces:** consumes `web/dist`; produces the deployable image + the rune handoff.

- [ ] **Step 1: `web/Dockerfile`** (context = repo root, mirroring agents/Dockerfile conventions):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY protocol/package.json protocol/
COPY agents/common/package.json agents/common/
COPY agents/worker/package.json agents/worker/
COPY agents/chatops/package.json agents/chatops/
COPY web/package.json web/
RUN npm ci
COPY protocol/ protocol/
COPY web/ web/
RUN npm run -w web build

FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
```

`web/nginx.conf`: listen 80; root html; `try_files $uri /index.html;` (SPA); `gzip on`.

- [ ] **Step 2: Pin NodePorts** in the two service manifests (30222 ws, 30080 web) with comments naming the UI default; `kubectl kustomize pre-gke/ > /dev/null && echo OK` (render ONLY).
- [ ] **Step 3: Local E2E script + run it.** `scripts/dev-ws.sh`: writes a temp nats config enabling `jetstream {}` + `websocket { port: 9222, no_tls: true }`, starts `nats-server -c` it on client port 4222-alt (e.g. 4348), prints instructions. Manual check (do it, record output/screenshot-notes in the report): terminal A `scripts/dev-ws.sh`; terminal B `NATS_URL=nats://127.0.0.1:4348 npx tsx scripts/fake-chatops.ts`; terminal C `npm run -w web dev` and open `http://localhost:5173/?ws=ws://127.0.0.1:9222`; type a message → verify: user line appears (stream echo), chatops chunks render bare, `[worker-fake-lynx]` delegate lines interleave, pulses travel the rail, worker tap appears/greys, stream counter climbs, tap-click ghost replay runs. Kill everything after.
- [ ] **Step 4: Docs.** `pre-gke/README.md` M3 handoff: rebuild/push `web` image (`docker build -t 10.3.10.52:5000/a2a-demo/web:latest -f web/Dockerfile . && docker push …`), re-apply (`kubectl apply -k pre-gke/` — NodePort pins change two services), then audience URL **`http://10.3.10.3:30080`** (any node IP works); report back a screenshot + the demo-prompts run. Root README: "Demo (browser)" section with the URL + `?ws=` override note.
- [ ] **Step 5: Commit** `feat(m3): web image, pinned NodePorts, local E2E script, M3 handoff` — after root `npm test` green + `typecheck:web` clean.

---

## After M3

rune applies, reports the screenshot + transcript → demo-ready. Remaining backlog (ledgered in M2): chatops turn timeout/maxTurns, inbox self-heal, restart-orphan terminal events — none block the demo.
