# ui-tweaks — web

bnaylor-approved UI tweaks from real UX testing (`tweaks.md`, "Tweaks to the ui"
plus the sample prompts from "Tweaks to the experience"). One commit, no push.

## What changed

### 1. Markdown-lite (`web/src/markdown.tsx`, new)

`**bold**`, `*italic*` / `_italic_` and `` `inline code` `` parsed into
`<strong>` / `<em>` / `<code>` React nodes. No `dangerouslySetInnerHTML`
anywhere: every string goes through React's own escaping, so `<b>hi</b>` in
agent output renders as the literal text `<b>hi</b>`.

Deliberately conservative where the syntax is ambiguous — an unclosed `**`, a
`*` used as multiplication (`2 * 3 * 4`), a `_` inside `snake_case_name` all
stay literal, because a wrong emphasis in a fast-scrolling transcript is worse
than a missing one. Code spans are located up front so an emphasis run can
never close against a delimiter that is really inside backticks
(``**run `a**b` now**`` behaves like CommonMark).

Applied to user, chatops and delegate text, and to both halves of a thinking
twisty (latest line and expanded log).

### 2. Thinking twisties (`model.ts`, `Chat.tsx`)

Thinking chunks (chatops or worker, any `message-chunk` whose text starts with
`[thinking] `) no longer interleave as transcript lines. The reducer routes
them into one accumulating entry per `(session, taskId)` with
`{ lines: string[], latest: string }`. Deltas arrive token-wise, so the tail
line is an open accumulator and only a newline in the delta closes it.

`Chat` renders each as one collapsed row, pinned in transcript order where the
reasoning first appeared:

```
▸ ▮ [otter] [thinking] Let me search for brunch spots in Toronto…
```

`latest` updates live; clicking toggles the full coherent log (monospace, dim,
hairline left rule). `aria-expanded` on the row, `aria-label` "Thinking log for
`<session>`".

The related fix, and the reason the whole thing exists: `appendChunk` now skips
*thinking* entries (and only those) when looking for a bubble to merge into, so
narrative that brackets a burst of reasoning lands in one entry instead of
being sawn in half by the twisty between the halves. A delegate genuinely
cutting in still ends the previous speaker's turn. `[progress]` lines are
untouched — they are deliberate milestones.

**Deviation from the brief, on purpose:** the brief's sketch puts the chevron
before the correlation chip. The chip is the transcript's left gutter and every
other entry aligns on it, so the twisty keeps chip-then-chevron. Same
information, alignment preserved.

### 3. Proactive summaries (`model.test.ts`)

Verified rather than changed. A chat task ChatOps publishes for itself — chatops
chunks, no `user` submission in front of it — already reduces to an ordinary
`chatops` entry carrying the *delegate's* correlation id, so the chip matches
the thread it is summarising. Four tests lock it in (renders normally, corr id
matches, does not merge into the previous turn's bubble, does not retire the
chatops agent). No reducer change was needed.

### 4. Terminal agents are user-driven (`model.ts`, `Rail.tsx`)

The two-second auto-fade-and-remove path is gone. Done and closed workers stay
on the rail, greyed (closed also gets a dashed lead), indefinitely.

New reducer event `{ type: "dismiss", session }` removes an agent at the view
level. Hovering a terminal tap reveals a small ✕ — SVG, `role="button"`,
`aria-label="Dismiss <session>"`, keyboard-operable. It is a *sibling* of the
replay button, not a child: nesting one control inside another hides it from
screen readers that honour the presentational-children rule.

This is the root cause of "sometimes the terminated agents have the replay
option, sometimes they don't" — the tap and its ghost replay were being removed
on a timer. Replay is now consistently available on every terminal tap.

### 5. Pulse emphasis (`Rail.tsx`, `styles.css`)

Same instrument-trace language, louder. Radii and wake lengths up across the
board with the ratios between kinds unchanged (`message-chunk` 2→3.4px,
`artifact-update` 5.5→7.5px; wakes 26→58 and 96→168). Wake opacity .38→.62,
glow blur 3.2→4.4. Each charge now has a white-hot core so it reads as lit
rather than painted, and the last 18% of a flight blooms a short ring into the
destination tap so an arrival catches the eye. Ghost pulses got the same
treatment at a quieter level (r 2.5→4.4, wake 30→76, opacity .5→.8). No
confetti; reduced-motion still suppresses movement and bloom.

### 6. Replay chunk peek (`rail-layout.ts`, `model.ts`, `Rail.tsx`)

`GhostStep` gains `excerpt?: string` and the strip shows the current step's
first line as each ghost step plays. `excerptOf()` (in `model.ts`, pure) takes
the first line, strips control characters, folds whitespace and elides at 80
chars; `Pulse` carries the excerpt so the live-pulse replay path has it, and
the reconstructed-from-history path derives it from chat text and artifacts.
`fitPeek` clips further to whatever the rail is actually wide enough for.

### 7. Header (`App.tsx`, `styles.css`)

A 34px nameplate strip above the rail: "a2a stream demo" left in the
established mono-uppercase silkscreen, a GitHub mark + "source" right, linking
to the repo with `target="_blank" rel="noopener noreferrer"`. Nothing lit — the
rail stays the only bright surface. `.app-topology` moved from `flex: 0 0 45%`
to `flex: 1 1 45%` with a `240px` floor so the panels share the remaining
height and the taller SVG (168→184px, for the peek line) never overflows.

### 8. README

Three Canada-focused prompts added verbatim under "Demo prompts" as items 6-8,
noted as longer-running research demos (Haiku finishes too fast to show the
rail under load).

## Verification

- `npm run -w web test` — **164 passed** (91 before, 73 new)
- `npm run typecheck:web` — clean
- `npm run -w web build` — green
- `npm test` (root) — 42 passed / 4 skipped, untouched
- `npm run typecheck` (root) — clean

### Live CDP check

Ran the M3 flow: `scripts/dev-ws.sh` + a throwaway publisher (deleted, not
committed) + `vite dev` + headless Chrome over CDP at 1440×900.

Observed:
- Header renders; link is `https://github.com/bnaylor/a2a-stream-demo` with
  `rel="noopener noreferrer"`.
- `document.body.scrollHeight === window.innerHeight` (900) — nothing overflows.
- Three twisties side by side (chatops, otter, lynx), each showing its own
  latest line; clicking one expanded to the two-line coherent log.
- ChatOps narrative rendered as **one** entry — "Spinning up a worker for that —
  **otter** is on it." — with its thinking below it, not through it.
- Bold / italic / inline code all rendered as elements.
- `otter` sat at `tap-done`, `lynx` at `tap-closed`, both still on the rail,
  both with a working Replay button and a ✕; clicking a ✕ dropped that tap and
  left the others alone.
- Ghost replay peek stepped through: `[thinking] that have good parking.` →
  `Toronto brunch shortlist with parking notes`.
- Live pulses: bright cyan cores with long wakes, visible bloom rings landing at
  `chatops` and `you`. Reads as traffic now rather than as noise on the trace.

## Concerns

- **Emphasis heuristics are heuristics.** `*` and `_` runs that open or close
  against whitespace are left literal, which is right far more often than not
  but will occasionally decline to italicise something a full markdown parser
  would. Block markdown (lists, headings, fences) is still literal text — out
  of scope, and arguably correct for a transcript.
- **Thinking entries key on `(session, taskId)`.** A worker that reasons across
  two tasks gets two twisties, which is intended; a worker whose chunks carry no
  `taskId` at all would get one twisty for its whole life. Nothing on the wire
  does that today.
- **`dismiss` is view-level only.** A dismissed agent reappears if a fresh
  envelope from that session arrives, and on page reload history rebuilds it.
  That matches "vanish" as a view affordance, but it is not persistent.
- The ✕ sits ~15px above the rail line. It does not overlap the trace, but on a
  very dense rail it is close to a neighbouring tap's label at minimum pitch.
- Pulse sizing is now near the top of what the trace can carry without the
  wakes of adjacent kinds merging during a burst; further emphasis would want
  a different device (colour or thickness), not more size.

---

# Fix round (review findings 1-4)

## 1. Continuous hover target for the dismiss ✕ — *important*

Correct diagnosis. The ✕ only existed while `.tap-slot:hover`, and in SVG an
unpainted gap is not hovered: the dot, the label and the ✕ are three painted
islands, so the cursor crossing the ~6px diagonal between them dropped
`:hover`, which flipped `pointer-events` back to `none` mid-approach.

Fix: a transparent `<rect class="tap-hover-target">` inside the slot group,
`MIN_WORKER_PITCH` (84px) wide and centred on the tap, running from 26px above
the rail (clear of the ✕) down past the status line — `fill: none` plus
`pointer-events: all`, which is what makes an unpainted rect a hit target. It
is the group's **first** child, so it sits behind the painted controls and they
keep their own clicks; the rect has no handler at all, it only holds `:hover`.
Rendered only on dismissable taps. ✕ visuals unchanged.

**Verified with a real hit-test** (CDP `Input.dispatchMouseEvent`, not scripted
`.click()`): eight physical `mouseMoved` events along the diagonal from the
`otter` label to the ✕, sampling computed style and `elementFromPoint` at each:

```
  step 0 @ (474,233) opacity=1 pointer-events=auto under=tap-name
  step 2 @ (478,219) opacity=1 pointer-events=auto under=tap-hover-target
  step 5 @ (483,199) opacity=1 pointer-events=auto under=tap-hover-target
  step 7 @ (486,185) opacity=1 pointer-events=auto under=tap-dismiss-hit
  step 8 @ (488,178) opacity=1 pointer-events=auto under=tap-dismiss-x
  RESULT: control stayed hittable the whole way
```

Then a physical `mousePressed`/`mouseReleased` at the ✕: taps went
`you,chatops,otter` → `you,chatops`.

Two unit tests as well: the rect exists and spans the slot geometry (full
pitch, centred, top above `cy - r` of the ✕, bottom past the status baseline,
✕ inside horizontally), and it is the first child of the slot and absent on
live taps.

## 2. Markdown in progress notes

Fixed — `[progress]` text now goes through the same renderer as every other
kind. Test: a progress entry containing `**2 of 4**` renders a `<strong>`.
Confirmed live: `<strong>2 of 4</strong>`.

## 3. Twisty accessible name

Correct — a bare "Thinking log for otter" overrode the row's content and hid
the latest line, the one thing the row exists to show. Now
`aria-label={`Thinking log for ${session}: ${latest}`}`, which keeps the
control's purpose *and* the readout; open/closed stays on `aria-expanded`.
Chose this over dropping the label because the bare content would read as
"[otter] [thinking] …" with the bracket noise and no statement of what
activating the control does. Live check: `Thinking log for otter: Let me check
the parking situation.`

## 4. Thinking log cap and per-delta cost

Fixed both halves:

- **Uncapped growth.** `MAX_THINKING_LINES = 500`; on overflow the log is cut
  to the newest 399 lines behind a single `… (earlier thinking trimmed)` marker
  line. Trimming to 400 rather than to the cap means the re-join is amortised
  over the next 100 lines instead of running on every delta once the cap is
  reached. The old marker always sits at index 0 and falls off with the rest of
  the head, so there is exactly one however many times the trim runs.
- **`join("\n")` per token.** `lines.join("\n")` is by construction just the
  delta stream concatenated, so the common path is now `prev.text + delta` and
  only a trim pays for a re-join. The `[...lines]` copy is still there — it is
  what keeps the reducer pure — but it is now bounded at 500 instead of
  unbounded. `latest` was already an O(1) scan from the end.

Five tests: stays under the cap, drops oldest / keeps newest and latest, marker
appears exactly once across four cap-lengths of input, `text === lines.join("\n")`
across a trim, and no trim under the cap.

## Verification (fix round)

- `npm run -w web test` — **173 passed** (164 → 173, 9 new)
- `npm run typecheck:web` — clean
- `npm run -w web build` — green
- `npm test` (root) — 45 passed / 4 skipped, untouched by this change (the
  count moved 42 → 45 because the chatops fix round landed in `f476312`
  meanwhile)
- `npm run typecheck` (root) — clean
