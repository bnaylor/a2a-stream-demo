import { useEffect, useReducer, useRef } from "react";
import { reduce, initialState } from "./model";
import { startBus, type BusHandle } from "./bus";
import Chat from "./Chat";

function wsUrl(): string {
  const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  const host = globalThis.location?.host ?? "localhost:4223";
  return `${protocol}//${host}/bus`;
}

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const busHandleRef = useRef<BusHandle | null>(null);

  useEffect(() => {
    const connect = async () => {
      try {
        busHandleRef.current = await startBus(wsUrl(), dispatch);
      } catch (error) {
        console.error("Failed to connect to bus:", error);
      }
    };

    connect();

    return () => {
      busHandleRef.current?.close().catch(() => {
        /* ignore */
      });
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
    <div style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 45%",
          borderBottom: "1px solid #ccc",
          padding: "16px",
          overflow: "auto",
        }}
      >
        <h2>Topology</h2>
        <p>a2a demo - topology zone</p>
      </div>
      <div
        style={{
          flex: "0 0 55%",
          padding: "16px",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Chat entries={state.chat} onPublishChat={handlePublishChat} />
      </div>
    </div>
  );
}
