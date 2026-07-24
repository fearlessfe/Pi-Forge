import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentTraceEvent, PiAgentEventType } from "../src/contracts.js";

type MissingAgentEventTypes = Exclude<AgentSessionEvent["type"], PiAgentEventType>;
type UnknownAgentEventTypes = Exclude<PiAgentEventType, AgentSessionEvent["type"]>;

// These assignments intentionally fail compilation whenever the SDK adds, removes,
// or renames an AgentSessionEvent. That keeps the desktop event contract exhaustive.
const agentEventTypesAreComplete: [MissingAgentEventTypes, UnknownAgentEventTypes] extends [never, never]
  ? true
  : never = true;
void agentEventTypesAreComplete;

const redactedKeys = new Set([
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "textsignature",
  "thinkingsignature",
  "thoughtsignature",
  "x-api-key",
]);

function toIpcSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((item) => toIpcSafe(item, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = redactedKeys.has(key.toLowerCase()) ? "[REDACTED]" : toIpcSafe(entry, seen);
  }
  seen.delete(value);
  return output;
}

function capturePayload(event: AgentSessionEvent): unknown {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "agent_settled":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "queue_update":
    case "compaction_start":
    case "compaction_end":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return toIpcSafe(event);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function captureAgentSessionEvent(event: AgentSessionEvent, sequence: number): AgentTraceEvent {
  return {
    sequence,
    timestamp: Date.now(),
    eventType: event.type,
    payload: capturePayload(event),
  };
}
