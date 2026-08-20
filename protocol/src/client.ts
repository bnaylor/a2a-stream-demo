import { NatsConnection, consumerOpts } from "nats";
import { Envelope, encodeEnvelope, parseEnvelope } from "./envelope.ts";
import { STREAM_NAME } from "./stream.ts";
import { taskEventsSubject } from "./subjects.ts";

export async function publishEnvelope(
  nc: NatsConnection, subject: string, env: Envelope,
): Promise<void> {
  await nc.jetstream().publish(subject, encodeEnvelope(env));
}

async function countMessages(nc: NatsConnection, subject: string): Promise<number> {
  const jsm = await nc.jetstreamManager();
  const info = await jsm.streams.info(STREAM_NAME, { subjects_filter: subject });
  return info.state.subjects?.[subject] ?? 0;
}

export async function replayTaskEvents(nc: NatsConnection, taskId: string): Promise<Envelope[]> {
  const subject = taskEventsSubject(taskId);
  const count = await countMessages(nc, subject);
  if (count === 0) return [];
  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.deliverAll();
  const sub = await nc.jetstream().subscribe(subject, opts);
  const out: Envelope[] = [];
  for await (const m of sub) {
    out.push(parseEnvelope(m.data));
    if (out.length >= count) break;
  }
  sub.unsubscribe();
  return out;
}

export async function subscribeTaskEvents(
  nc: NatsConnection, taskId: string, onEnvelope: (env: Envelope) => void,
): Promise<() => void> {
  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.deliverAll();
  const sub = await nc.jetstream().subscribe(taskEventsSubject(taskId), opts);
  (async () => {
    for await (const m of sub) onEnvelope(parseEnvelope(m.data));
  })().catch(() => { /* subscription closed */ });
  return () => sub.unsubscribe();
}
