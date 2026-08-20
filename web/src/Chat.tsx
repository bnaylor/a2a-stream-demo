import { useEffect, useRef, useState } from "react";
import type { ChatEntry } from "./model.ts";
import { corrColor } from "./model.ts";

interface ChatProps {
  entries: ChatEntry[];
  onPublishChat: (text: string) => void;
}

/**
 * Transcript pane: auto-scroll pinned to bottom unless user scrolled up.
 * Entries rendered by kind:
 * - user: right-aligned or "you>" prefix
 * - chatops: plain text
 * - delegate: "[session]" prefix, colored by session
 * - progress: dimmer with ⏳ glyph
 * Each exchange group gets one correlation chip colored by corrColor(corrId).
 */
export default function Chat({ entries, onPublishChat }: ChatProps) {
  const [text, setText] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

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
    } else if (entry.kind === "user") {
      content = (
        <div className="chat-entry chat-user">
          <span>{glyphs.user}</span>
          <span>{entry.text}</span>
        </div>
      );
    } else if (entry.kind === "delegate") {
      content = (
        <div className="chat-entry chat-delegate">
          <span>{glyphs.delegate}</span>
          <span>{entry.text}</span>
        </div>
      );
    } else {
      // chatops
      content = (
        <div className="chat-entry chat-chatops">
          <span>{entry.text}</span>
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
