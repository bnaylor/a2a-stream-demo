import { useEffect, useReducer, useRef } from "react";
import { reduce, initialState } from "./model.ts";
import { startBus, type BusHandle } from "./bus.ts";
import { wsUrl } from "./config.ts";
import Chat from "./Chat.tsx";
import Rail from "./Rail.tsx";
import "./styles.css";

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const busHandleRef = useRef<BusHandle | null>(null);

  useEffect(() => {
    // StrictMode runs this effect twice in dev, and cleanup fires before the
    // first `startBus` resolves — without this flag the first connection is
    // never closed and every envelope gets dispatched twice.
    let cancelled = false;

    const connect = async () => {
      try {
        const handle = await startBus(wsUrl(), dispatch);
        if (cancelled) {
          void handle.close().catch(() => {
            /* already going away */
          });
          return;
        }
        busHandleRef.current = handle;
      } catch (error) {
        // The page is now useless, so say so on the rail rather than only here.
        console.error("Failed to connect to bus:", error);
        if (!cancelled) dispatch({ type: "connection", state: "down" });
      }
    };

    void connect();

    return () => {
      cancelled = true;
      busHandleRef.current?.close().catch(() => {
        /* ignore */
      });
      busHandleRef.current = null;
    };
  }, []);

  const handlePublishChat = async (text: string) => {
    if (!busHandleRef.current) {
      console.error("Bus not connected");
      return;
    }
    try {
      // This doesn't add an optimistic entry — the reducer adds it when the
      // submission echoes back from the stream (per brief design decision)
      await busHandleRef.current.publishChat(text);
    } catch (error) {
      console.error("Failed to publish chat:", error);
    }
  };

  return (
    <div className="app">
      <header className="app-head">
        <span className="app-title">a2a stream demo</span>
        <a
          className="app-repo"
          href="https://github.com/bnaylor/a2a-stream-demo"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg className="app-repo-mark" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
            />
          </svg>
          source
        </a>
      </header>
      <div className="app-topology">
        <Rail
          state={state}
          onDismiss={(session) => dispatch({ type: "dismiss", session })}
        />
      </div>
      <div className="app-chat">
        <Chat entries={state.chat} onPublishChat={handlePublishChat} />
      </div>
    </div>
  );
}
