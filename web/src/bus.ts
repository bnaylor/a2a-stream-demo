/**
 * The browser's connection to the bus. One websocket, three sources of
 * dispatch: the JetStream replay+live tap on `a2a.>`, the core heartbeat
 * subject, and a wall-clock tick that ages agents out.
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

export async function startBus(
  url: string,
  dispatch: (e: BusEvent) => void,
): Promise<BusHandle> {
  const nc: NatsConnection = await connect({ servers: url });
  const js = nc.jetstream();

  // Snapshot where the stream ends *before* subscribing: everything at or
  // below this sequence is history being replayed into the UI, everything
  // above it is happening now and earns a pulse on the rail.
  let lastSeqAtConnect = 0;
  try {
    const info = await (await nc.jetstreamManager()).streams.info(STREAM_NAME);
    lastSeqAtConnect = info.state.last_seq;
  } catch {
    // No stream yet (fresh cluster): every message is live.
  }

  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.deliverAll();
  const events: JetStreamSubscription = await js.subscribe(EVENT_SUBJECT, opts);
  void (async () => {
    for await (const m of events) {
      let env: Envelope;
      try {
        env = parseEnvelope(m.data);
      } catch {
        continue; // not ours, or malformed — the stream is shared
      }
      dispatch({ type: "envelope", env, live: m.info.streamSequence > lastSeqAtConnect });
    }
  })().catch(() => {
    /* subscription closed */
  });

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

  return {
    async publishChat(text: string) {
      const { env, taskId, correlationId } = buildChatTask(text);
      await js.publish(taskRequestSubject(taskId), encodeEnvelope(env));
      return { taskId, correlationId };
    },
    async close() {
      clearInterval(timer);
      events.unsubscribe();
      heartbeats.unsubscribe();
      await nc.close();
    },
  };
}
