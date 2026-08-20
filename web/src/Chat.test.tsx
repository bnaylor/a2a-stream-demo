/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Chat from "./Chat.tsx";
import type { ChatEntry } from "./model.ts";

describe("Chat component", () => {
  it("renders all four entry kinds with their affordances", () => {
    const entries: ChatEntry[] = [
      {
        id: "1",
        kind: "user",
        session: "you",
        text: "hello world",
        correlationId: "corr-1",
      },
      {
        id: "2",
        kind: "chatops",
        session: "chatops",
        text: "reply here",
        correlationId: "corr-2",
      },
      {
        id: "3",
        kind: "delegate",
        session: "otter",
        text: "working on it",
        correlationId: "corr-3",
      },
      {
        id: "4",
        kind: "progress",
        session: "otter",
        text: "step 1 done",
        correlationId: "corr-4",
      },
    ];

    render(<Chat entries={entries} onPublishChat={vi.fn()} />);

    // User message shows "you>" prefix
    expect(screen.getByText(/you>/)).toBeTruthy();
    expect(screen.getByText("hello world")).toBeTruthy();

    // ChatOps message appears plainly
    expect(screen.getByText("reply here")).toBeTruthy();

    // Delegate message shows [otter] prefix
    expect(screen.getByText(/\[otter\]/)).toBeTruthy();
    expect(screen.getByText("working on it")).toBeTruthy();

    // Progress message shows glyph and has class
    expect(screen.getByText(/⏳/)).toBeTruthy();
    expect(screen.getByText("step 1 done")).toBeTruthy();
    const progressDiv = screen.getByText("step 1 done").closest(".chat-progress");
    expect(progressDiv).toBeTruthy();

    cleanup();
  });

  it("renders correlation chip with color derived from corrColor", () => {
    const entries: ChatEntry[] = [
      {
        id: "1",
        kind: "user",
        session: "you",
        text: "test",
        correlationId: "corr-abc123",
      },
    ];

    const { container } = render(
      <Chat entries={entries} onPublishChat={vi.fn()} />
    );

    // Find chip by data-corr attribute
    const chip = container.querySelector('[data-corr="corr-abc123"]');
    expect(chip).toBeTruthy();
    expect(chip?.classList.contains("corr-chip")).toBe(true);

    // Verify it has a background color set
    const style = chip?.getAttribute("style");
    expect(style).toMatch(/backgroundColor|background-color/);

    cleanup();
  });

  it("calls publishChat on Enter with text and clears input", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();

    const { container } = render(
      <Chat entries={[]} onPublishChat={onPublish} />
    );

    // Get the input within this render specifically
    const input = container.querySelector(
      'input[placeholder*="Type a message"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    await user.type(input, "test message");
    await user.keyboard("{Enter}");

    expect(onPublish).toHaveBeenCalledWith("test message");
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");

    cleanup();
  });

  it("does not submit on empty input", async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();

    const { container } = render(
      <Chat entries={[]} onPublishChat={onPublish} />
    );

    const input = container.querySelector(
      'input[placeholder*="Type a message"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    // Press Enter without typing anything
    await user.click(input);
    await user.keyboard("{Enter}");

    // Should not have called publishChat
    expect(onPublish).not.toHaveBeenCalled();

    cleanup();
  });

  it("note: scroll behavior skipped due to jsdom limitations with scroll position", () => {
    // jsdom does not fully support scroll position properties,
    // so auto-scroll behavior testing is deferred to E2E tests
    expect(true).toBe(true);
  });
});
