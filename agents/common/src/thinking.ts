/**
 * What we ask the model for when we want a thinking twisty with something in
 * it.
 *
 * Background, because this is not obvious from the option name. Left to its
 * defaults the API runs a *redacted* thinking phase: it streams `thinking_delta`
 * frames that carry only token estimates, no text ("otherwise streams only
 * pings" — claude-agent-sdk `sdk.d.ts:4895`). The A2A mapper faithfully turns
 * each of those into `"[thinking] "` with nothing behind it, and the UI has no
 * reasoning to show. Verified on the live stream 2026-08-20: all 74 thinking
 * chunks were the bare marker.
 *
 * `display: 'summarized'` is what changes that. Note there is no raw/plaintext
 * mode — `sdk.d.ts` offers `'summarized' | 'omitted'` and nothing else — so a
 * summary is the most the twisty can ever show.
 *
 * The shape is declared structurally rather than imported: this package has no
 * SDK dependency, and the call sites are type-checked against the real
 * `ThinkingConfig` when they hand it to `query()`.
 */

/** Mirrors `ThinkingConfig` in claude-agent-sdk `sdk.d.ts:7931`. */
export type ThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };

/** Modest by default: the twisty is worth a little latency, not a lot. */
export const DEFAULT_THINKING_BUDGET = 2048;

/**
 * Models that pick their own thinking depth (`sdk.d.ts:7921`, "Opus 4.6+").
 * Anything not on this list gets the explicit budget form, which is the
 * pre-4.6 shape and the one the API needs a `budgetTokens` for.
 *
 * Unknown models fall through to the explicit form on purpose: over-specifying
 * a budget still yields summarized thinking, whereas asking a pre-4.6 model for
 * `adaptive` risks getting no thinking at all — which is the bug this exists to
 * fix.
 */
const ADAPTIVE_MODELS = [/^claude-opus-4-[6-9]/, /^claude-opus-[5-9]/, /^claude-sonnet-[5-9]/, /^claude-fable-[5-9]/];

export function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_MODELS.some((re) => re.test(model));
}

/**
 * The `thinking` option for a model, always asking for summaries.
 *
 * `budget` is only consulted for the explicit form; an adaptive model is
 * trusted to choose, which is the point of adaptive.
 */
export function thinkingConfig(model: string, budget = DEFAULT_THINKING_BUDGET): ThinkingConfig {
  if (supportsAdaptiveThinking(model)) {
    return { type: "adaptive", display: "summarized" };
  }
  return { type: "enabled", budgetTokens: budget, display: "summarized" };
}

/** Reads a budget override, ignoring anything that is not a positive number. */
export function thinkingBudgetFromEnv(
  raw: string | undefined,
  fallback = DEFAULT_THINKING_BUDGET,
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
