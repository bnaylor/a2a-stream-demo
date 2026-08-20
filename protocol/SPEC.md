# a2a-jetstream v0.1

## Stream

| Property | Value |
|----------|-------|
| Name | A2A |
| Subjects | a2a.> |
| Storage | File |
| Retention | Limits |
| Max Age | 24 h |
| Max Bytes | 256 MB |

Note: Heartbeats are core NATS, outside the stream.

## Subjects

| Pattern | Purpose |
|---------|---------|
| `a2a.tasks.{taskId}.request` | Task submission (one message) |
| `a2a.tasks.{taskId}.events` | Status updates, streamed message chunks, artifacts, terminal event from executing agent |
| `a2a.agents.{session}` | Agent card published once on startup, closing tombstone on shutdown |
| `agents.hb.{agentType}.{owner}.{session}` | Core-NATS heartbeat every 15 s (outside the A2A stream) |

## Envelope

All messages conform to this structure:

```json
{
  "protocol": "a2a-jetstream/0.1",
  "correlationId": "corr-…",
  "taskId": "task-…",
  "contextId": "ctx-…",
  "ts": "2026-08-19T21:00:00Z",
  "from": { "session": "worker-brisk-otter", "agentType": "claude-code" },
  "kind": "task | status-update | message-chunk | artifact-update | agent-card | agent-closed",
  "payload": { }
}
```

### Field Rules

- **taskId** / **contextId**: Required for kinds `task`, `status-update`, `message-chunk`, `artifact-update`. Optional for `agent-card`, `agent-closed`.
- **ts**: ISO-8601 UTC timestamp.
- **kind**: Enum: `task | status-update | message-chunk | artifact-update | agent-card | agent-closed`.

## Lifecycle

Task states progress: `submitted → working → completed | failed | canceled`

A terminal status-update carries `final: true`. Status queries are answered by replay of `a2a.tasks.{taskId}.events`.

## Heartbeats

Heartbeats are published to `agents.hb.{agentType}.{owner}.{session}` at 15 second intervals. They are core-NATS messages, outside the A2A stream.

Heartbeat payload example:

```json
{
  "agent": "claude-code",
  "owner": "bnaylor",
  "session": "chatops",
  "instance_id": "<uuid>",
  "ts": "2026-08-19T21:00:00Z",
  "interval_s": 15
}
```

This shape is Synadia-compatible.

## Versioning

The `protocol` field is bumped on breaking change. Consumers MUST ignore unknown envelope fields and MUST reject unknown `protocol` values.
