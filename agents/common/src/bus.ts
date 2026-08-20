import { connect, NatsConnection } from "nats";
import {
  AgentIdentity,
  Envelope,
  ensureStream,
  makeEnvelope,
  newCorrelationId,
  publishEnvelope,
  agentCardSubject,
  startHeartbeat,
  taskEventsSubject,
} from "@a2a-demo/protocol";

export interface Bus {
  nc: NatsConnection;
  publishEvent(taskId: string, env: Envelope): Promise<void>;
  close(): Promise<void>;
}

export async function connectBus(cfg: {
  natsUrl: string;
  identity: AgentIdentity;
  description?: string;
}): Promise<Bus> {
  const nc = await connect({ servers: cfg.natsUrl });
  await ensureStream(await nc.jetstreamManager());
  const from = {
    session: cfg.identity.session,
    agentType: cfg.identity.agentType,
  };
  const cardCorr = newCorrelationId();
  await publishEnvelope(
    nc,
    agentCardSubject(cfg.identity.session),
    makeEnvelope({
      kind: "agent-card",
      correlationId: cardCorr,
      from,
      payload: {
        session: cfg.identity.session,
        agentType: cfg.identity.agentType,
        owner: cfg.identity.owner,
        startedAt: new Date().toISOString(),
        description: cfg.description,
      },
    })
  );
  const stopHb = startHeartbeat(nc, cfg.identity);
  return {
    nc,
    publishEvent: (taskId, env) =>
      publishEnvelope(nc, taskEventsSubject(taskId), env),
    close: async () => {
      stopHb();
      await publishEnvelope(
        nc,
        agentCardSubject(cfg.identity.session),
        makeEnvelope({
          kind: "agent-closed",
          correlationId: cardCorr,
          from,
          payload: { session: cfg.identity.session },
        })
      );
      await nc.drain();
    },
  };
}
