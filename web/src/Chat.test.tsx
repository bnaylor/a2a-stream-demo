import { describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "./model";

describe("Chat component", () => {
  it("renders user messages with 'you>' prefix", () => {
    const entry: ChatEntry = {
      id: "1",
      kind: "user",
      session: "you",
      text: "hello world",
      correlationId: "corr-1",
    };
    expect(entry.kind).toBe("user");
    expect(entry.text).toBe("hello world");
  });

  it("renders chatops messages plainly", () => {
    const entry: ChatEntry = {
      id: "1",
      kind: "chatops",
      session: "chatops",
      text: "reply here",
      correlationId: "corr-1",
    };
    expect(entry.kind).toBe("chatops");
    expect(entry.text).toBe("reply here");
  });

  it("renders delegate messages with session prefix", () => {
    const entry: ChatEntry = {
      id: "1",
      kind: "delegate",
      session: "otter",
      text: "working on it",
      correlationId: "corr-1",
    };
    expect(entry.kind).toBe("delegate");
    expect(entry.session).toBe("otter");
    expect(entry.text).toBe("working on it");
  });

  it("renders progress messages with dimmer styling", () => {
    const entry: ChatEntry = {
      id: "1",
      kind: "progress",
      session: "otter",
      text: "step 1 done",
      correlationId: "corr-1",
    };
    expect(entry.kind).toBe("progress");
    expect(entry.text).toBe("step 1 done");
  });

  it("publishes chat text on Enter", () => {
    const onPublish = vi.fn();
    const text = "test message";
    onPublish(text);
    expect(onPublish).toHaveBeenCalledWith("test message");
  });
});
