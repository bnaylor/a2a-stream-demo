import { describe, expect, it } from "vitest";
import { newCorrelationId, newSessionName, newTaskId } from "./ids.ts";

describe("ids", () => {
  it("prefixes ids by kind", () => {
    expect(newTaskId()).toMatch(/^task-[0-9a-f-]{36}$/);
    expect(newCorrelationId()).toMatch(/^corr-[0-9a-f-]{36}$/);
  });
  it("generates worker-adjective-animal session names", () => {
    expect(newSessionName()).toMatch(/^worker-[a-z]+-[a-z]+$/);
  });
  it("does not repeat task ids", () => {
    expect(newTaskId()).not.toEqual(newTaskId());
  });
});
