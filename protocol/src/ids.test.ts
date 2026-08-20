import { describe, expect, it } from "vitest";
import {
  SESSION_NAME_WORDS,
  newCorrelationId,
  newSessionName,
  newTaskId,
} from "./ids.ts";

describe("ids", () => {
  it("prefixes ids by kind", () => {
    expect(newTaskId()).toMatch(/^task-[0-9a-f-]{36}$/);
    expect(newCorrelationId()).toMatch(/^corr-[0-9a-f-]{36}$/);
  });
  it("generates short single-word session names", () => {
    expect(newSessionName()).toMatch(/^[a-z]{3,6}$/);
  });
  it("draws from a deduplicated pool of short lowercase words", () => {
    // Checking the pool itself, not a sample: one stray "Otter" or
    // "hippopotamus" would otherwise only show up as a rare flake.
    expect(SESSION_NAME_WORDS.length).toBeGreaterThanOrEqual(48);
    expect(new Set(SESSION_NAME_WORDS).size).toBe(SESSION_NAME_WORDS.length);
    for (const word of SESSION_NAME_WORDS) {
      expect(word).toMatch(/^[a-z]{3,6}$/);
    }
  });
  it("does not repeat task ids", () => {
    expect(newTaskId()).not.toEqual(newTaskId());
  });
});
