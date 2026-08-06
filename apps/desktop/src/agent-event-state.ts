import type { AgentEvent } from "./contracts";
import { appendMessageDelta } from "./conversation-activity";
import { mergeAnswerUsage } from "./response-usage";
import type { ChatTurn } from "./types";

function lastMatchingIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function activateQueuedTurn(turns: ChatTurn[], event: Extract<AgentEvent, { type: "user.message.started" }>): ChatTurn[] {
  const belongsToRun = (turn: ChatTurn) => turn.status === "queued" && (!turn.runId || turn.runId === event.runId);
  let targetIndex = turns.findIndex((turn) => belongsToRun(turn) && turn.question === event.message);
  if (targetIndex < 0) targetIndex = turns.findIndex(belongsToRun);
  if (targetIndex < 0) return turns;

  return turns.map((turn, index) => {
    if (index === targetIndex) return { ...turn, runId: event.runId, status: "running" };
    if (turn.status === "running" && (!turn.runId || turn.runId === event.runId)) {
      return { ...turn, runId: event.runId, status: "completed" };
    }
    return turn;
  });
}

function settleRun(turns: ChatTurn[], event: Extract<AgentEvent, { type: "run.completed" | "run.error" | "run.stopped" }>): ChatTurn[] {
  const hasMatchingRun = turns.some((turn) => turn.runId === event.runId);
  if (!hasMatchingRun) return turns;
  return turns.map((turn) => {
    const belongsToRun = turn.runId === event.runId || (hasMatchingRun && turn.status === "queued" && !turn.runId);
    if (!belongsToRun) return turn;
    if (turn.status === "queued") return { ...turn, status: "cancelled" };
    if (turn.status !== "running") return turn;
    if (event.type === "run.completed") return { ...turn, status: "completed" };
    if (event.type === "run.stopped") return { ...turn, status: "stopped" };
    return { ...turn, status: "error", error: event.message };
  });
}

export function applyAgentEvent(turns: ChatTurn[], event: AgentEvent): ChatTurn[] {
  if (event.type === "runtime.status"
    || event.type === "conversation.updated"
    || event.type === "context.updated"
    || event.type === "queue.updated"
    || event.type === "agent.event") return turns;
  if (event.type === "user.message.started") return activateQueuedTurn(turns, event);
  if (event.type === "run.completed" || event.type === "run.error" || event.type === "run.stopped") {
    return settleRun(turns, event);
  }

  let targetIndex = lastMatchingIndex(turns, (turn) => turn.runId === event.runId && turn.status === "running");
  if (targetIndex < 0) targetIndex = lastMatchingIndex(turns, (turn) => turn.runId === event.runId);
  if (targetIndex < 0) targetIndex = lastMatchingIndex(turns, (turn) => turn.status === "running" && !turn.runId);
  if (targetIndex < 0) return turns;

  return turns.map((turn, index) => {
    if (index !== targetIndex) return turn;
    const current = turn.runId ? turn : { ...turn, runId: event.runId };

    switch (event.type) {
      case "run.started":
        return current;
      case "message.delta":
        return {
          ...current,
          answer: current.answer + event.text,
          activities: appendMessageDelta(current.activities, event.text),
        };
      case "thinking.delta": {
        const last = current.activities.at(-1);
        const activities = last?.type === "thinking"
          ? current.activities.map((item, itemIndex) => itemIndex === current.activities.length - 1 && item.type === "thinking"
            ? { ...item, text: item.text + event.text }
            : item)
          : [...current.activities, { id: `thinking-${current.activities.length}`, type: "thinking" as const, text: event.text }];
        return { ...current, activities };
      }
      case "tool.started":
        return {
          ...current,
          activities: [...current.activities, {
            id: event.callId,
            type: "tool",
            name: event.name,
            args: event.args,
            output: "",
            status: "running",
          }],
        };
      case "tool.updated":
        return {
          ...current,
          activities: current.activities.map((item) => item.type === "tool" && item.id === event.callId
            ? { ...item, output: event.output, details: event.details ?? item.details }
            : item),
        };
      case "tool.completed":
        return {
          ...current,
          activities: current.activities.map((item) => item.type === "tool" && item.id === event.callId
            ? { ...item, output: event.output, status: event.isError ? "error" : "success", details: event.details ?? item.details }
            : item),
        };
      case "question.requested":
        return {
          ...current,
          activities: [...current.activities.filter((item) => !(item.type === "question" && item.id === event.callId)), {
            id: event.callId,
            type: "question",
            question: event.question,
            options: event.options,
            status: "pending",
          }],
        };
      case "plan.review.draft": {
        const existing = current.activities.some((item) => item.type === "plan_review" && item.id === event.draft.toolCallId);
        const activity = {
          id: event.draft.toolCallId,
          type: "plan_review" as const,
          title: event.draft.title,
          markdown: event.draft.markdown,
          status: "streaming" as const,
        };
        return {
          ...current,
          activities: existing
            ? current.activities.map((item) => item.type === "plan_review" && item.id === event.draft.toolCallId ? activity : item)
            : [...current.activities, activity],
        };
      }
      case "plan.review.requested":
      case "plan.review.resolved": {
        const version = event.review.versions.find((entry) => entry.id === event.review.activeVersionId) ?? event.review.versions.at(-1);
        const activity = {
          id: event.review.toolCallId,
          type: "plan_review" as const,
          title: event.review.title,
          markdown: version?.markdown ?? "",
          status: event.review.status,
          review: event.review,
        };
        const draftIndex = current.activities.findIndex((item) => item.type === "plan_review" && item.id === event.review.toolCallId);
        const reviewIndex = current.activities.findIndex((item) => item.type === "plan_review" && item.review?.id === event.review.id);
        const targetIndex = draftIndex >= 0 ? draftIndex : reviewIndex;
        return {
          ...current,
          activities: targetIndex >= 0
            ? current.activities.flatMap((item, index) => {
                if (index === targetIndex) return [activity];
                return item.type === "plan_review" && item.review?.id === event.review.id ? [] : [item];
              })
            : [...current.activities, activity],
        };
      }
      case "response.usage":
        return { ...current, usage: mergeAnswerUsage(current.usage, event.usage) };
      case "changes.updated":
        return { ...current, fileChanges: event.changes };
    }
  });
}

export function isStreamingAgentEvent(event: AgentEvent): event is Extract<AgentEvent, { type: "message.delta" | "thinking.delta" | "plan.review.draft" }> {
  return event.type === "message.delta" || event.type === "thinking.delta" || event.type === "plan.review.draft";
}

export function coalesceStreamingAgentEvents(events: AgentEvent[]): AgentEvent[] {
  const result: AgentEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (event.type === "plan.review.draft" && previous?.type === event.type && previous.runId === event.runId && previous.draft.toolCallId === event.draft.toolCallId) {
      result[result.length - 1] = event;
    } else if ((event.type === "message.delta" || event.type === "thinking.delta") && previous?.type === event.type && previous.runId === event.runId) {
      result[result.length - 1] = { ...previous, text: previous.text + event.text };
    } else {
      result.push(event);
    }
  }
  return result;
}

export function applyAgentEvents(turns: ChatTurn[], events: AgentEvent[]): ChatTurn[] {
  return coalesceStreamingAgentEvents(events).reduce(applyAgentEvent, turns);
}
