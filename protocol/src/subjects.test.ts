import { describe, expect, it } from "vitest";
import {
  agentCardSubject, heartbeatSubject, taskEventsSubject,
  taskIdFromSubject, taskRequestSubject,
} from "./subjects.ts";

describe("subjects", () => {
  it("builds spec §3.2 subjects verbatim", () => {
    expect(taskRequestSubject("task-1")).toBe("a2a.tasks.task-1.request");
    expect(taskEventsSubject("task-1")).toBe("a2a.tasks.task-1.events");
    expect(agentCardSubject("worker-brisk-otter")).toBe("a2a.agents.worker-brisk-otter");
    expect(heartbeatSubject("claude-code", "bnaylor", "chatops"))
      .toBe("agents.hb.claude-code.bnaylor.chatops");
  });
  it("rejects tokens containing NATS-reserved characters", () => {
    for (const bad of ["a.b", "a b", "a*", "a>", ""]) {
      expect(() => taskRequestSubject(bad)).toThrow(/invalid subject token/);
    }
  });
  it("extracts taskId from task subjects, null otherwise", () => {
    expect(taskIdFromSubject("a2a.tasks.task-9.events")).toBe("task-9");
    expect(taskIdFromSubject("a2a.tasks.task-9.request")).toBe("task-9");
    expect(taskIdFromSubject("a2a.agents.chatops")).toBeNull();
  });
});
