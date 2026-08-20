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
      <div className="app-topology">
        <Rail state={state} />
      </div>
      <div className="app-chat">
        <Chat entries={state.chat} onPublishChat={handlePublishChat} />
      </div>
    </div>
  );
}
