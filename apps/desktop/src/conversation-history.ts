import type { ContextUsageInfo, ConversationActivity, ResponseUsage, TaskFileChange } from "./contracts.js";
import type { ChatTurn } from "./types.js";

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
