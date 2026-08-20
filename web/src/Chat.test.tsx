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

describe("Chat: inline markdown", () => {
  const entry = (kind: ChatEntry["kind"], text: string): ChatEntry => ({
    id: "1",
    kind,
    session: "otter",
    text,
    correlationId: "corr-1",
  });

  it("renders bold, italic and code in chatops output", () => {
    const { container } = render(
      <Chat entries={[entry("chatops", "**done**: see *docs* and `spec.md`")]} onPublishChat={vi.fn()} />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("done");
    expect(container.querySelector("em")?.textContent).toBe("docs");
    expect(container.querySelector("code")?.textContent).toBe("spec.md");
    cleanup();
  });

  it("renders bold in delegate and user text too", () => {
    const { container } = render(
      <Chat
        entries={[
          { ...entry("delegate", "found **three** sources"), id: "1" },
          { ...entry("user", "make it **fast**"), id: "2" },
        ]}
        onPublishChat={vi.fn()}
      />,
    );
    expect(Array.from(container.querySelectorAll("strong")).map((e) => e.textContent)).toEqual([
      "three",
      "fast",
    ]);
    cleanup();
  });

  it("renders markdown in progress notes too", () => {
    const { container } = render(
      <Chat entries={[entry("progress", "fetched **2 of 4** sources")]} onPublishChat={vi.fn()} />,
    );
    expect(container.querySelector(".chat-progress strong")?.textContent).toBe("2 of 4");
    cleanup();
  });

  it("leaves raw HTML in agent text as inert text", () => {
    const { container } = render(
      <Chat entries={[entry("chatops", "<b>not bold</b>")]} onPublishChat={vi.fn()} />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>not bold</b>")).toBeTruthy();
    cleanup();
  });
});

describe("Chat: thinking twisties", () => {
  const thinking: ChatEntry = {
    id: "t1",
    kind: "thinking",
    session: "otter",
    text: "one\ntwo\nthree",
    correlationId: "corr-1",
    lines: ["one", "two", "three"],
    latest: "three",
  };

  it("collapses a thinking entry into one row showing the latest line", () => {
    render(<Chat entries={[thinking]} onPublishChat={vi.fn()} />);
    const row = screen.getByRole("button", { name: /^Thinking log for otter:/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toContain("▸");
    expect(row.textContent).toContain("[otter]");
    expect(row.textContent).toContain("[thinking]");
    expect(row.textContent).toContain("three");
    // Collapsed: the earlier lines are not in the tree at all.
    expect(screen.queryByText("one")).toBeNull();
    cleanup();
  });

  it("expands to the full log on click and collapses again", async () => {
    const user = userEvent.setup();
    const { container } = render(<Chat entries={[thinking]} onPublishChat={vi.fn()} />);
    const row = screen.getByRole("button", { name: /^Thinking log for otter:/ });

    await user.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.textContent).toContain("▾");
    const log = container.querySelector(".thinking-log");
    expect(Array.from(log?.querySelectorAll(".thinking-line") ?? []).map((n) => n.textContent)).toEqual([
      "one",
      "two",
      "three",
    ]);

    await user.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".thinking-log")).toBeNull();
    cleanup();
  });

  it("keeps one twisty per agent, each with its own latest line", () => {
    render(
      <Chat
        entries={[
          thinking,
          { ...thinking, id: "t2", session: "lynx", lines: ["a"], latest: "a" },
        ]}
        onPublishChat={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Thinking log for otter:/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Thinking log for lynx:/ })).toBeTruthy();
    cleanup();
  });

  it("renders markdown inside the twisty content", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Chat
        entries={[
          {
            ...thinking,
            lines: ["weighing `nats` options", "picking **jetstream**"],
            latest: "picking **jetstream**",
          },
        ]}
        onPublishChat={vi.fn()}
      />,
    );
    expect(container.querySelector(".thinking-latest strong")?.textContent).toBe("jetstream");
    await user.click(screen.getByRole("button", { name: /^Thinking log for otter:/ }));
    expect(container.querySelector(".thinking-log code")?.textContent).toBe("nats");
    cleanup();
  });

  // A bare "Thinking log for otter" would override the row's own content and
  // hide the latest line from a screen reader — the one thing the row shows.
  it("exposes the latest line in the accessible name, and state via aria-expanded", async () => {
    const user = userEvent.setup();
    render(<Chat entries={[thinking]} onPublishChat={vi.fn()} />);
    const row = screen.getByRole("button", { name: "Thinking log for otter: three" });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await user.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    // The name tracks the readout rather than the open/closed state.
    expect(row.getAttribute("aria-label")).toBe("Thinking log for otter: three");
    cleanup();
  });

  it("does not disturb the surrounding transcript", () => {
    render(
      <Chat
        entries={[
          { id: "a", kind: "chatops", session: "chatops", text: "before", correlationId: "c" },
          { ...thinking, id: "b", correlationId: "c" },
          { id: "c", kind: "chatops", session: "chatops", text: "after", correlationId: "c" },
        ]}
        onPublishChat={vi.fn()}
      />,
    );
    expect(screen.getByText("before")).toBeTruthy();
    expect(screen.getByText("after")).toBeTruthy();
    cleanup();
  });
});
