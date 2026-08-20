import { useEffect, useReducer, useRef } from "react";
import { reduce, initialState } from "./model";
import { startBus, type BusHandle } from "./bus";
import { wsUrl } from "./config";
import Chat from "./Chat";
import Rail from "./Rail";
import "./styles.css";

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
