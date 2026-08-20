import { McpServerConfig, query } from "@anthropic-ai/claude-agent-sdk";
import {
  SdkMsg,
  thinkingBudgetFromEnv,
  thinkingConfig,
} from "@a2a-demo/agents-common";

export interface ChatSession {
  send(prompt: string): AsyncIterable<SdkMsg>;
}

export interface SdkChatSessionOptions {
  mcpServers?: Record<string, McpServerConfig>;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

const DEFAULT_ALLOWED = ["mcp__a2a__*"];
const DEFAULT_DISALLOWED = [
  "Write",
  "Edit",
  "Bash",
  "NotebookEdit",
  "WebSearch",
  "Read",
  "Glob",
  "Grep",
];

interface SdkSystemInit {
  type?: string;
  subtype?: string;
  session_id?: string;
}

/**
 * A single, persistent Claude conversation: the first turn starts a session,
 * later turns pass `resume: sessionId` so ChatOps keeps its chat history.
 */
export function makeSdkChatSession(
  model: string,
  opts: SdkChatSessionOptions = {}
): ChatSession {
  let sessionId: string | undefined;

  return {
    send(prompt: string): AsyncIterable<SdkMsg> {
      return (async function* () {
        const stream = query({
          prompt,
          options: {
            model,
            ...(sessionId ? { resume: sessionId } : {}),
            permissionMode: "dontAsk",
            includePartialMessages: true,
            // Same reason as the worker: the default redacted phase streams
            // thinking pings with no text, leaving ChatOps' twisty empty.
            thinking: thinkingConfig(
              model,
              thinkingBudgetFromEnv(process.env.CHATOPS_THINKING_BUDGET),
            ),
            mcpServers: opts.mcpServers,
            allowedTools: opts.allowedTools ?? DEFAULT_ALLOWED,
            disallowedTools: opts.disallowedTools ?? DEFAULT_DISALLOWED,
            ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
          },
        });
        for await (const msg of stream) {
          const init = msg as SdkSystemInit;
          if (
            init.type === "system" &&
            init.subtype === "init" &&
            typeof init.session_id === "string"
          ) {
            sessionId = init.session_id;
          }
          // SDKMessage is a superset of the subset the A2A mapper reads.
          yield msg as unknown as SdkMsg;
        }
      })();
    },
  };
}
