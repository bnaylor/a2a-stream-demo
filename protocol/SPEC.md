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
| `a2a.tasks.{taskId}.commands` | Agent receives task assignments and directives |
| `a2a.tasks.{taskId}.events` | Agent publishes status updates and completion events |
| `a2a.agents.{agentType}.heartbeats` | Periodic liveness signals from agents |
| `a2a.stream.{streamId}.messages` | Application-level message interchange |

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

Heartbeats are published to `a2a.agents.{agentType}.heartbeats` at 15 second intervals.

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
