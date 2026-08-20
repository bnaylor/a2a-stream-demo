export type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled";

export interface TaskStatus {
  state: TaskState;
  timestamp: string; // ISO-8601 UTC
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
}

export interface MessagePart {
  kind: "text";
  text: string;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: MessagePart[];
  messageId: string;
}

export interface TaskStatusUpdate {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final: boolean;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: MessagePart[];
}

export interface AgentIdentity {
  agentType: string; // e.g. "claude-code"
  owner: string;     // e.g. "bnaylor"
  session: string;   // e.g. "chatops", "worker-brisk-otter"
  instanceId: string;
}

export interface AgentCard {
  session: string;
  agentType: string;
  owner: string;
  startedAt: string; // ISO-8601
  description?: string;
}
