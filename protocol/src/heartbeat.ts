import { NatsConnection } from "nats";
import { heartbeatSubject } from "./subjects.ts";
import { AgentIdentity } from "./types.ts";

export interface Heartbeat {
  agent: string;
  owner: string;
  session: string;
  instance_id: string;
  ts: string;
  interval_s: number;
}

export function makeHeartbeat(id: AgentIdentity, now: Date, intervalS = 15): Heartbeat {
  return {
    agent: id.agentType,
    owner: id.owner,
    session: id.session,
    instance_id: id.instanceId,
    ts: now.toISOString(),
    interval_s: intervalS,
  };
}

export function startHeartbeat(nc: NatsConnection, id: AgentIdentity, intervalS = 15): () => void {
  const subject = heartbeatSubject(id.agentType, id.owner, id.session);
  const publish = () =>
    nc.publish(subject, JSON.stringify(makeHeartbeat(id, new Date(), intervalS)));
  publish();
  const timer = setInterval(publish, intervalS * 1000);
  return () => clearInterval(timer);
}
