/**
 * The browser's connection to the bus. One websocket, four sources of
 * dispatch: the JetStream replay+live tap on `a2a.>`, the core heartbeat
 * subject, a wall-clock tick that ages agents out, and the connection's own
 * status.
 *
 * Nothing here is allowed to fail silently. The two things that go wrong in
 * front of an audience — the server not being there, and the `A2A` stream not
 * existing yet on a fresh cluster — both used to reject out of `startBus` and
 * leave a dead page with a clean console. Now the heartbeat tap, the tick and
 * the status watcher come up independently of JetStream, and the JetStream
 * attach retries in the background while the UI says so.
 *
 * Everything imported from the protocol package is imported by path, from the
 * pure modules only — `stream.ts`, `client.ts` and `heartbeat.ts` all pull in
 * `nats` (node) and would break the bundle.
 */
import { connect, consumerOpts, type NatsConnection, type Subscription } from "nats.ws";
import type { JetStreamSubscription } from "nats.ws";
import { encodeEnvelope, parseEnvelope, type Envelope } from "@a2a-demo/protocol/src/envelope.ts";
import { taskRequestSubject } from "@a2a-demo/protocol/src/subjects.ts";
import type { BusEvent } from "./model.ts";
import { buildChatTask } from "./submit.ts";

/**
 * Literal on purpose: the protocol's `STREAM_NAME` lives in `stream.ts`, which
 * imports node-only `nats` internals. Keep in sync with protocol/src/stream.ts.
 */
const STREAM_NAME = "A2A";
const EVENT_SUBJECT = "a2a.>";
const HEARTBEAT_SUBJECT = "agents.hb.>";
const TICK_MS = 5_000;
/** How long to wait before trying to attach to the stream again. */
const STREAM_RETRY_MS = 3_000;

export interface BusHandle {
  publishChat(text: string): Promise<{ taskId: string; correlationId: string }>;
  close(): Promise<void>;
}

/**
 * `agents.hb.{agentType}.{owner}.{session}` — the subject alone identifies the
 * pod, so a heartbeat is useful even when its body is unreadable.
 */
function agentFromHeartbeat(
  subject: string,
  data: Uint8Array,
): { session: string; agentType?: string } | null {
  const parts = subject.split(".");
  const agentType = parts.length === 5 ? parts[2] : undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(data)) as { session?: string };
    if (typeof payload.session === "string" && payload.session !== "") {
      return { session: payload.session, agentType };
    }
  } catch {
    // fall through to the subject, which carries the same name
  }
  return parts.length === 5 ? { session: parts[4], agentType } : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startBus(
  url: string,
  dispatch: (e: BusEvent) => void,
): Promise<BusHandle> {
  // `waitOnFirstConnect` turns "server isn't up yet" from a rejection into a
  // retry, and an unlimited reconnect budget means a NATS restart mid-demo
  // heals itself instead of needing a page reload.
  const nc: NatsConnection = await connect({
    servers: url,
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const js = nc.jetstream();
  let closed = false;

  // Heartbeats and the tick do not touch JetStream, so they come up first and
  // stay up even if the stream never appears: the rail can still show live
  // pods and age them out.
  const heartbeats: Subscription = nc.subscribe(HEARTBEAT_SUBJECT, {
    callback: (err, m) => {
      if (err) return;
      const agent = agentFromHeartbeat(m.subject, m.data);
      // Local clock, not the payload's: staleness is measured against the
      // browser's own `tick`, and the two clocks may disagree.
      if (agent) dispatch({ type: "heartbeat", ...agent, at: Date.now() });
    },
  });

  const timer = setInterval(() => dispatch({ type: "tick", now: Date.now() }), TICK_MS);

  dispatch({ type: "connection", state: "up" });
  void (async () => {
    for await (const s of nc.status()) {
      if (s.type === "disconnect") dispatch({ type: "connection", state: "down" });
      if (s.type === "reconnect") dispatch({ type: "connection", state: "up" });
    }
  })().catch(() => {
    /* status iterator ends with the connection */
  });
  void nc.closed().then(() => {
    if (!closed) dispatch({ type: "connection", state: "down" });
  });

  // On a fresh cluster the `A2A` stream does not exist yet and subscribing
  // throws "no stream matches subject". That used to reject out of startBus
  // and kill the whole UI; instead, keep trying in the background and report
  // the wait as "connecting".
  let events: JetStreamSubscription | null = null;
  void (async () => {
    let complained = false;
    while (!closed) {
      try {
        // Snapshot where the stream ends *before* subscribing: everything at
        // or below this sequence is history being replayed into the UI,
        // everything above it is happening now and earns a pulse on the rail.
        let lastSeqAtConnect = 0;
        try {
          const info = await (await nc.jetstreamManager()).streams.info(STREAM_NAME);
          lastSeqAtConnect = info.state.last_seq;
        } catch {
          // The stream exists by the time we subscribe below, or we retry;
          // either way a missing snapshot just means "treat it all as live".
        }

        const opts = consumerOpts();
        opts.orderedConsumer();
        opts.deliverAll();
        const sub = await js.subscribe(EVENT_SUBJECT, opts);
        if (closed) {
          sub.unsubscribe();
          return;
        }
        events = sub;
        dispatch({ type: "connection", state: "up" });
        for await (const m of sub) {
          let env: Envelope;
          try {
            env = parseEnvelope(m.data);
          } catch {
            continue; // not ours, or malformed — the stream is shared
          }
          dispatch({ type: "envelope", env, live: m.info.streamSequence > lastSeqAtConnect });
        }
        return; // subscription ended cleanly (close())
      } catch (error) {
        if (closed) return;
        events = null;
        if (!complained) {
          console.warn(
            `Waiting for the ${STREAM_NAME} stream (retrying every ${STREAM_RETRY_MS / 1000}s):`,
            error,
          );
          complained = true;
        }
        dispatch({ type: "connection", state: "connecting" });
        await sleep(STREAM_RETRY_MS);
      }
    }
  })();

  return {
    async publishChat(text: string) {
      const { env, taskId, correlationId } = buildChatTask(text);
      await js.publish(taskRequestSubject(taskId), encodeEnvelope(env));
      return { taskId, correlationId };
    },
    async close() {
      closed = true;
      clearInterval(timer);
      events?.unsubscribe();
      heartbeats.unsubscribe();
      await nc.close();
    },
  };
}
