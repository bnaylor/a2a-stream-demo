import { describe, expect, it } from "vitest";
import {
  DEFAULT_THINKING_BUDGET,
  supportsAdaptiveThinking,
  thinkingBudgetFromEnv,
  thinkingConfig,
} from "./thinking.ts";

describe("thinkingConfig", () => {
  // The whole point: without this the API streams redacted pings with no text
  // and the UI's twisties have nothing to show.
  it("always asks for summaries", () => {
    for (const model of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-6"]) {
      const cfg = thinkingConfig(model);
      expect(cfg).toHaveProperty("display", "summarized");
      expect(cfg.type).not.toBe("disabled");
    }
  });

  // haiku-4-5 predates adaptive, so it needs the explicit budget form — asking
  // it for `adaptive` risks getting no thinking at all, which is the bug.
  it("gives haiku-4-5 an explicit budget", () => {
    expect(thinkingConfig("claude-haiku-4-5")).toEqual({
      type: "enabled",
      budgetTokens: DEFAULT_THINKING_BUDGET,
      display: "summarized",
    });
  });

  it("honours a caller-supplied budget", () => {
    expect(thinkingConfig("claude-haiku-4-5", 512)).toMatchObject({ budgetTokens: 512 });
  });

  it("lets an adaptive model choose its own depth", () => {
    expect(thinkingConfig("claude-sonnet-5")).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    // The budget is not imposed on a model that picks for itself.
    expect(thinkingConfig("claude-sonnet-5", 512)).not.toHaveProperty("budgetTokens");
  });

  // Fail safe: an unrecognised model still gets thinking, just pinned.
  it("falls back to the explicit form for an unknown model", () => {
    expect(thinkingConfig("some-future-model")).toMatchObject({
      type: "enabled",
      display: "summarized",
    });
  });
});

describe("supportsAdaptiveThinking", () => {
  it("recognises the families the SDK documents as adaptive", () => {
    for (const m of ["claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-5", "claude-fable-5"]) {
      expect(supportsAdaptiveThinking(m)).toBe(true);
    }
  });

  it("does not claim it for pre-4.6 models", () => {
    for (const m of ["claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5", ""]) {
      expect(supportsAdaptiveThinking(m)).toBe(false);
    }
  });
});

describe("thinkingBudgetFromEnv", () => {
  it("uses the default when unset", () => {
    expect(thinkingBudgetFromEnv(undefined)).toBe(DEFAULT_THINKING_BUDGET);
  });

  it("reads a positive number", () => {
    expect(thinkingBudgetFromEnv("4096")).toBe(4096);
  });

  it("ignores junk, zero and negatives rather than sending them to the API", () => {
    for (const raw of ["", "abc", "0", "-1", "NaN"]) {
      expect(thinkingBudgetFromEnv(raw)).toBe(DEFAULT_THINKING_BUDGET);
    }
  });

  it("floors a fractional budget", () => {
    expect(thinkingBudgetFromEnv("1024.7")).toBe(1024);
  });
});
