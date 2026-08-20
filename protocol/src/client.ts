import { NatsConnection, consumerOpts } from "nats";
import { Envelope, encodeEnvelope, parseEnvelope } from "./envelope.ts";
import { STREAM_NAME } from "./stream.ts";
import { taskEventsSubject, taskRequestSubject } from "./subjects.ts";

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
  let seen = 0;
  try {
    for await (const m of sub) {
      seen++;
      try {
        out.push(parseEnvelope(m.data));
      } catch {
        // Skip malformed envelopes
      }
      if (seen >= count) break;
    }
  } finally {
    sub.unsubscribe();
  }
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
    for await (const m of sub) {
      let env: Envelope;
      try {
        env = parseEnvelope(m.data);
      } catch {
        // Skip malformed envelopes
        continue;
      }
      onEnvelope(env);
    }
  })().catch(() => { /* subscription closed */ });
  return () => sub.unsubscribe();
}

export async function submitTask(nc: NatsConnection, env: Envelope): Promise<void> {
  if (env.kind !== "task" || !env.taskId) throw new Error("submitTask requires a task envelope with taskId");
  await publishEnvelope(nc, taskRequestSubject(env.taskId), env);
}

export async function fetchTaskRequest(nc: NatsConnection, taskId: string): Promise<Envelope | null> {
  const subject = taskRequestSubject(taskId);
  const jsm = await nc.jetstreamManager();
  try {
    const m = await jsm.streams.getMessage(STREAM_NAME, { last_by_subj: subject });
    return parseEnvelope(m.data);
  } catch {
    return null;
  }
}

export async function watchTaskRequests(
  nc: NatsConnection, session: string, onEnvelope: (env: Envelope) => void,
): Promise<() => void> {
  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.deliverNew();
  const sub = await nc.jetstream().subscribe("a2a.tasks.*.request", opts);
  (async () => {
    for await (const m of sub) {
      let env: Envelope;
      try {
        env = parseEnvelope(m.data);
      } catch {
        continue;
      }
      if (env.to?.session === session) onEnvelope(env);
    }
  })().catch(() => { /* subscription closed */ });
  return () => sub.unsubscribe();
}
