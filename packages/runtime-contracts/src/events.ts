import type {
  ContextUsageInfo,
  ConversationUpdatedEvent,
  PlanReviewArtifact,
  PlanReviewDraft,
  QuestionOption,
  QueuedMessages,
  ResponseUsage,
  TaskFileChange,
  ToolActivityDetails,
} from "./session.js";

export const piAgentEventTypes = [
  "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end", "tool_execution_start",
  "tool_execution_update", "tool_execution_end", "queue_update", "compaction_start",
  "compaction_end", "entry_appended", "session_info_changed", "thinking_level_changed",
  "auto_retry_start", "auto_retry_end", "summarization_retry_scheduled",
  "summarization_retry_attempt_start", "summarization_retry_finished",
] as const;

export type PiAgentEventType = typeof piAgentEventTypes[number];

export type AgentTraceEvent = {
  sequence: number;
  timestamp: number;
  eventType: PiAgentEventType;
  payload: unknown;
};

export type AgentRuntimeStatus = "running" | "crash-looping" | "unresponsive";

export const runtimeEventTypes = [
  "runtime.status", "run.started", "user.message.started", "message.delta", "thinking.delta",
  "tool.started", "tool.updated", "tool.completed", "question.requested", "plan.review.draft",
  "plan.review.requested", "plan.review.resolved", "response.usage", "context.updated", "queue.updated",
  "changes.updated", "agent.event", "conversation.updated", "run.completed", "run.stopped", "run.error",
] as const satisfies readonly AgentEvent["type"][];

export type AgentEvent =
  | { type: "runtime.status"; status: AgentRuntimeStatus; conversationId?: string }
  | { type: "run.started"; runId: string; conversationId: string; provider: string; model: string; cwd: string }
  | { type: "user.message.started"; conversationId?: string; runId: string; message: string }
  | { type: "message.delta"; conversationId?: string; runId: string; text: string }
  | { type: "thinking.delta"; conversationId?: string; runId: string; text: string }
  | { type: "tool.started"; conversationId?: string; runId: string; callId: string; name: string; args: unknown }
  | { type: "tool.updated"; conversationId?: string; runId: string; callId: string; name: string; output: string; details?: ToolActivityDetails }
  | { type: "tool.completed"; conversationId?: string; runId: string; callId: string; name: string; output: string; isError: boolean; details?: ToolActivityDetails }
  | { type: "question.requested"; conversationId?: string; runId: string; callId: string; question: string; options: QuestionOption[] }
  | { type: "plan.review.draft"; conversationId?: string; runId: string; draft: PlanReviewDraft }
  | { type: "plan.review.requested"; conversationId?: string; runId: string; review: PlanReviewArtifact }
  | { type: "plan.review.resolved"; conversationId?: string; runId: string; review: PlanReviewArtifact }
  | { type: "response.usage"; conversationId?: string; runId: string; usage: ResponseUsage }
  | { type: "context.updated"; conversationId?: string; runId: string; usage: ContextUsageInfo }
  | { type: "queue.updated"; conversationId?: string; runId: string; queue: QueuedMessages }
  | { type: "changes.updated"; conversationId?: string; runId: string; changes: TaskFileChange[] }
  | { type: "agent.event"; conversationId?: string; runId: string; event: AgentTraceEvent }
  | ConversationUpdatedEvent
  | { type: "run.completed"; conversationId?: string; runId: string }
  | { type: "run.stopped"; conversationId?: string; runId: string }
  | { type: "run.error"; conversationId?: string; runId: string; message: string };

/** Durable, globally ordered desktop event record. Offsets start at 1 and never repeat. */
export type RuntimeEventRecord = {
  schemaVersion: 1;
  offset: number;
  eventId: string;
  recordedAt: string;
  conversationId?: string;
  runId?: string;
  turnId?: string;
  toolCallId?: string;
  event: AgentEvent;
};

export type RuntimeEventQuery = {
  conversationId?: string;
  runId?: string;
  turnId?: string;
  toolCallId?: string;
  eventTypes?: AgentEvent["type"][];
  afterOffset?: number;
  limit?: number;
};

export type RuntimeEventPage = {
  events: RuntimeEventRecord[];
  nextOffset: number;
  highWatermark: number;
  hasMore: boolean;
};

export type RuntimeEventCheckpoint = {
  schemaVersion: 1;
  name: string;
  offset: number;
  updatedAt: string;
};

export type RuntimeReplayTool = {
  callId: string;
  name: string;
  status: "running" | "completed" | "error";
  args?: unknown;
  output?: string;
  details?: ToolActivityDetails;
  startedOffset: number;
  completedOffset?: number;
};

export type RuntimeReplayTurn = {
  turnId: string;
  runId: string;
  userMessage?: string;
  assistantText: string;
  thinkingText: string;
  tools: RuntimeReplayTool[];
  startedOffset: number;
  completedOffset?: number;
};

export type RuntimeReplayRun = {
  runId: string;
  conversationId?: string;
  status: "running" | "completed" | "stopped" | "error";
  provider?: string;
  model?: string;
  cwd?: string;
  error?: string;
  turns: RuntimeReplayTurn[];
  startedOffset: number;
  completedOffset?: number;
};

export type RuntimeReplaySnapshot = {
  schemaVersion: 1;
  afterOffset: number;
  highWatermark: number;
  runs: RuntimeReplayRun[];
};
