import type { ContextUsageInfo, ConversationActivity, ResponseUsage, SubagentRunInfo, TaskFileChange, ToolActivityDetails, TurnAttachment } from "./contracts.js";
import type { ChatTurn } from "./types.js";

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeSubagentRun(value: unknown): SubagentRunInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as Record<string, unknown>;
  if (
    typeof run.id !== "string"
    || typeof run.toolCallId !== "string"
    || typeof run.role !== "string"
    || typeof run.task !== "string"
    || typeof run.cwd !== "string"
    || typeof run.sessionId !== "string"
    || !["queued", "running", "paused", "completed", "error", "stopped"].includes(run.status as string)
    || typeof run.startedAt !== "string"
    || typeof run.updatedAt !== "string"
  ) return undefined;
  return {
    id: run.id,
    parentRunId: typeof run.parentRunId === "string" ? run.parentRunId : undefined,
    parentConversationId: typeof run.parentConversationId === "string" ? run.parentConversationId : undefined,
    toolCallId: run.toolCallId,
    role: run.role,
    task: run.task,
    cwd: run.cwd,
    sessionId: run.sessionId,
    modelSettings: run.modelSettings && typeof run.modelSettings === "object"
      ? run.modelSettings as SubagentRunInfo["modelSettings"]
      : undefined,
    status: run.status as SubagentRunInfo["status"],
    attempt: typeof run.attempt === "number" && Number.isInteger(run.attempt) && run.attempt >= 0 ? run.attempt : run.status === "running" ? 1 : 0,
    queuedAt: typeof run.queuedAt === "string" ? run.queuedAt : run.startedAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: typeof run.completedAt === "string" ? run.completedAt : undefined,
    result: typeof run.result === "string" ? run.result : undefined,
    usage: normalizeResponseUsage(run.usage),
    error: typeof run.error === "string" ? run.error : undefined,
  };
}

function normalizeToolDetails(value: unknown): ToolActivityDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  const subagent = normalizeSubagentRun(details.backgroundSubagent ?? details.subagent);
  return subagent ? { ...details, backgroundSubagent: subagent } : undefined;
}

function normalizeActivity(value: unknown, index: number): ConversationActivity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const activity = value as Record<string, unknown>;
  const id = typeof activity.id === "string" ? activity.id : `history-activity-${index}`;
  if (activity.type === "message") {
    return { id, type: "message", text: typeof activity.text === "string" ? activity.text : "" };
  }
  if (activity.type === "thinking") {
    return { id, type: "thinking", text: typeof activity.text === "string" ? activity.text : "" };
  }
  if (activity.type === "tool" && typeof activity.name === "string") {
    const status = activity.status === "error" || activity.status === "running" || activity.status === "success"
      ? activity.status
      : "error";
    return {
      id,
      type: "tool",
      name: activity.name,
      args: activity.args,
      output: typeof activity.output === "string" ? activity.output : "",
      status,
      details: normalizeToolDetails(activity.details),
    };
  }
  if (activity.type === "question") {
    const options = Array.isArray(activity.options)
      ? activity.options.flatMap((option) => {
          if (!option || typeof option !== "object" || typeof (option as Record<string, unknown>).label !== "string") return [];
          const candidate = option as Record<string, unknown>;
          return [{
            label: candidate.label as string,
            description: typeof candidate.description === "string" ? candidate.description : undefined,
          }];
        })
      : [];
    const answer = typeof activity.answer === "string" ? activity.answer : undefined;
    return {
      id,
      type: "question",
      question: typeof activity.question === "string" ? activity.question : "Pi 需要你的回答",
      options,
      answer,
      status: activity.status === "answered" || answer ? "answered" : "pending",
    };
  }
  return undefined;
}

function normalizeResponseUsage(value: unknown): ResponseUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.provider !== "string" || typeof usage.model !== "string") return undefined;
  return {
    provider: usage.provider,
    model: usage.model,
    responseModel: typeof usage.responseModel === "string" ? usage.responseModel : undefined,
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    cacheReadTokens: finiteNumber(usage.cacheReadTokens),
    cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
    totalTokens: finiteNumber(usage.totalTokens),
    requestCount: typeof usage.requestCount === "number" && Number.isInteger(usage.requestCount) && usage.requestCount > 0
      ? usage.requestCount
      : 1,
    cost: finiteNumber(usage.cost),
  };
}

function normalizeFileChange(value: unknown): TaskFileChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const change = value as Record<string, unknown>;
  if (
    typeof change.id !== "string"
    || typeof change.runId !== "string"
    || typeof change.callId !== "string"
    || typeof change.path !== "string"
    || typeof change.relativePath !== "string"
    || (change.kind !== "created" && change.kind !== "modified")
    || typeof change.patch !== "string"
    || typeof change.afterHash !== "string"
    || (change.status !== "pending" && change.status !== "accepted" && change.status !== "reverted" && change.status !== "conflict")
  ) return undefined;
  return {
    id: change.id,
    runId: change.runId,
    callId: change.callId,
    path: change.path,
    relativePath: change.relativePath,
    kind: change.kind,
    patch: change.patch,
    beforeHash: typeof change.beforeHash === "string" ? change.beforeHash : undefined,
    afterHash: change.afterHash,
    status: change.status,
    revertible: change.revertible === true,
    error: typeof change.error === "string" ? change.error : undefined,
  };
}

function normalizeTurnAttachment(value: unknown): TurnAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const attachment = value as Record<string, unknown>;
  if ((attachment.kind !== "image" && attachment.kind !== "file") || typeof attachment.name !== "string") return undefined;
  return {
    kind: attachment.kind,
    name: attachment.name,
    dataUrl: typeof attachment.dataUrl === "string" ? attachment.dataUrl : undefined,
    id: typeof attachment.id === "string" ? attachment.id : undefined,
    mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : undefined,
    size: typeof attachment.size === "number" ? attachment.size : undefined,
    access: attachment.access === "inline" || attachment.access === "tool" ? attachment.access : undefined,
  };
}

export function normalizeHistoryTurn(value: unknown, index: number): ChatTurn {
  const turn = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    id: typeof turn.id === "string" ? turn.id : `history-${index}`,
    sessionEntryId: typeof turn.id === "string" ? turn.id : undefined,
    question: typeof turn.question === "string" ? turn.question : "",
    answer: typeof turn.answer === "string" ? turn.answer : "",
    activities: Array.isArray(turn.activities)
      ? turn.activities.map(normalizeActivity).filter((activity): activity is ConversationActivity => Boolean(activity))
      : [],
    attachments: Array.isArray(turn.attachments)
      ? turn.attachments.map(normalizeTurnAttachment).filter((attachment): attachment is TurnAttachment => Boolean(attachment))
      : undefined,
    fileChanges: Array.isArray(turn.fileChanges)
      ? turn.fileChanges.map(normalizeFileChange).filter((change): change is TaskFileChange => Boolean(change))
      : undefined,
    usage: normalizeResponseUsage(turn.usage),
    status: "completed",
  };
}

export function normalizeContextUsage(value: unknown): ContextUsageInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.contextWindow !== "number" || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return undefined;
  const tokens = typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null;
  const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null;
  return { tokens, contextWindow: usage.contextWindow, percent };
}
