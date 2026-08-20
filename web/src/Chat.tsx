import { useEffect, useRef, useState } from "react";
import type { ChatEntry } from "./model.ts";
import { corrColor } from "./model.ts";
import Markdown from "./markdown.tsx";

interface ChatProps {
  entries: ChatEntry[];
  onPublishChat: (text: string) => void;
}

/**
 * Transcript pane: auto-scroll pinned to bottom unless user scrolled up.
 * Entries rendered by kind:
 * - user: "you>" prefix
 * - chatops: plain text
 * - delegate: "[session]" prefix
 * - progress: dimmer with ⏳ glyph — deliberate milestones, one line each
 * - thinking: one collapsed twisty per agent-task, pinned where the reasoning
 *   started and updated in place, so two agents thinking at once read as two
 *   quiet instruments rather than one shuffled deck
 *
 * Each exchange group gets one correlation chip colored by corrColor(corrId).
 */
export default function Chat({ entries, onPublishChat }: ChatProps) {
  const [text, setText] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Track scroll position to know if user scrolled up
  const handleScroll = () => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      // If within 10px of bottom, keep autoscroll enabled
      setShouldAutoScroll(scrollHeight - scrollTop - clientHeight < 10);
    }
  };

  // Auto-scroll to bottom if enabled
  useEffect(() => {
    if (shouldAutoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, shouldAutoScroll]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      onPublishChat(text);
      setText("");
    }
  };

  // Build the transcript with corr chips
  const renderedEntries = entries.map((entry, idx) => {
    const isFirstInGroup =
      idx === 0 || entries[idx - 1].correlationId !== entry.correlationId;
    const corrChip = isFirstInGroup ? (
      <div
        className="corr-chip"
        style={{ backgroundColor: corrColor(entry.correlationId) }}
        title={`Correlation: ${entry.correlationId.slice(0, 8)}...`}
        data-corr={entry.correlationId}
      />
    ) : null;

    let content: React.ReactNode = null;
    const glyphs =
      {
        user: "you>",
        chatops: "",
        delegate: `[${entry.session}]`,
        progress: "⏳",
      } as const;

    if (entry.kind === "progress") {
      content = (
        <div className="chat-entry chat-progress">
          <span>{glyphs.progress}</span>
          <span>{entry.text}</span>
        </div>
      );
    } else if (entry.kind === "thinking") {
      const open = expanded.has(entry.id);
      const lines = entry.lines ?? [];
      content = (
        <div className={`chat-entry chat-thinking${open ? " is-open" : ""}`}>
          <button
            type="button"
            className="thinking-row"
            aria-expanded={open}
            aria-label={`Thinking log for ${entry.session ?? "agent"}`}
            onClick={() => toggle(entry.id)}
          >
            <span className="thinking-twisty" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <span className="thinking-who">[{entry.session}]</span>
            <span className="thinking-tag">[thinking]</span>
            <span className="thinking-latest">
              <Markdown text={entry.latest ?? ""} />
            </span>
          </button>
          {open && (
            <div className="thinking-log">
              {lines.map((line, i) => (
                <div className="thinking-line" key={i}>
                  <Markdown text={line} />
                </div>
              ))}
            </div>
          )}
        </div>
      );
    } else if (entry.kind === "user") {
      content = (
        <div className="chat-entry chat-user">
          <span>{glyphs.user}</span>
          <span>
            <Markdown text={entry.text} />
          </span>
        </div>
      );
    } else if (entry.kind === "delegate") {
      content = (
        <div className="chat-entry chat-delegate">
          <span>{glyphs.delegate}</span>
          <span>
            <Markdown text={entry.text} />
          </span>
        </div>
      );
    } else {
      // chatops
      content = (
        <div className="chat-entry chat-chatops">
          <span>
            <Markdown text={entry.text} />
          </span>
        </div>
      );
    }

    return (
      <div key={entry.id} className="chat-entry-group">
        {corrChip}
        {content}
      </div>
    );
  });

  return (
    <div className="chat-pane">
      <div
        className="chat-transcript"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {renderedEntries}
      </div>
      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Type a message..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="chat-input"
        />
        <button type="submit" className="chat-submit">
          Send
        </button>
      </form>
    </div>
  );
}
