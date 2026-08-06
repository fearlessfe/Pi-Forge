import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./contracts";
import { applyAgentEvent, applyAgentEvents, coalesceStreamingAgentEvents, isStreamingAgentEvent, seedRecoveredUserMessage } from "./agent-event-state";
import type { ChatTurn } from "./types";

function turn(id: string, question: string, status: ChatTurn["status"], runId = "run-1"): ChatTurn {
  return { id, runId, question, answer: "", activities: [], status };
}

function apply(turns: ChatTurn[], event: AgentEvent): ChatTurn[] {
  return applyAgentEvent(turns, event);
}

describe("applyAgentEvent queue lifecycle", () => {
  it("seeds a missing turn before replaying renderer recovery events", () => {
    let turns = seedRecoveredUserMessage([], {
      type: "user.message.started",
      conversationId: "conversation-1",
      runId: "run-1",
      message: "Recover this task",
    }, "renderer-recovery-run-1-0");
    turns = apply(turns, { type: "message.delta", conversationId: "conversation-1", runId: "run-1", text: "Recovered" });
    turns = apply(turns, { type: "run.completed", conversationId: "conversation-1", runId: "run-1" });

    expect(turns).toMatchObject([{
      id: "renderer-recovery-run-1-0",
      runId: "run-1",
      question: "Recover this task",
      answer: "Recovered",
      status: "completed",
    }]);
  });

  it("activates queued messages in order and routes response deltas to the active message", () => {
    let turns = [
      turn("initial", "Initial task", "running"),
      { ...turn("queued-1", "First follow-up", "queued"), queueMode: "followUp" as const },
      { ...turn("queued-2", "Second follow-up", "queued"), queueMode: "followUp" as const },
    ];

    turns = apply(turns, { type: "user.message.started", runId: "run-1", message: "First follow-up" });
    expect(turns.map((candidate) => candidate.status)).toEqual(["completed", "running", "queued"]);

    turns = apply(turns, { type: "message.delta", runId: "run-1", text: "First answer" });
    expect(turns[0].answer).toBe("");
    expect(turns[1].answer).toBe("First answer");

    turns = apply(turns, { type: "user.message.started", runId: "run-1", message: "Second follow-up" });
    turns = apply(turns, { type: "message.delta", runId: "run-1", text: "Second answer" });
    turns = apply(turns, { type: "run.completed", runId: "run-1" });

    expect(turns.map((candidate) => candidate.status)).toEqual(["completed", "completed", "completed"]);
    expect(turns[1].answer).toBe("First answer");
    expect(turns[2].answer).toBe("Second answer");
  });

  it("uses FIFO order for duplicate or transformed queued message text", () => {
    const turns = [
      turn("initial", "Initial task", "running"),
      turn("queued-1", "Same message", "queued"),
      turn("queued-2", "Same message", "queued"),
    ];

    const next = apply(turns, { type: "user.message.started", runId: "run-1", message: "Expanded prompt content" });

    expect(next.map((candidate) => candidate.status)).toEqual(["completed", "running", "queued"]);
  });

  it("keeps unconsumed messages visible as not run when a task stops", () => {
    const turns = [
      turn("initial", "Initial task", "running"),
      turn("queued-1", "Pending follow-up", "queued"),
    ];

    const next = apply(turns, { type: "run.stopped", runId: "run-1" });

    expect(next.map((candidate) => candidate.status)).toEqual(["stopped", "cancelled"]);
  });

  it("ignores the initial user-message event when no queued turn exists", () => {
    const turns = [turn("initial", "Initial task", "running")];
    const next = apply(turns, { type: "user.message.started", runId: "run-1", message: "Initial task" });
    expect(next).toBe(turns);
  });

  it("does not activate or settle turns owned by a different run", () => {
    const turns = [
      turn("active", "Initial task", "running", "run-1"),
      turn("queued", "Follow-up", "queued", "run-1"),
    ];

    expect(apply(turns, { type: "user.message.started", runId: "run-other", message: "Follow-up" })).toBe(turns);
    expect(apply(turns, { type: "run.error", runId: "run-other", message: "wrong run" })).toBe(turns);
    expect(apply(turns, { type: "run.stopped", runId: "run-other" })).toBe(turns);
  });
});

describe("applyAgentEvent activity union", () => {
  it("binds an unassigned running turn when the run starts", () => {
    const turns = [{ ...turn("initial", "Initial", "running"), runId: undefined }];
    const next = apply(turns, {
      type: "run.started",
      runId: "run-bound",
      conversationId: "conversation-1",
      provider: "openai",
      model: "test-model",
      cwd: "/workspace",
    });
    expect(next[0].runId).toBe("run-bound");
  });

  it("tracks tool start, progress, completion, error state, and details", () => {
    let turns = [turn("initial", "Initial", "running")];
    turns = apply(turns, { type: "tool.started", runId: "run-1", callId: "call-1", name: "read", args: { path: "a.ts" } });
    turns = apply(turns, { type: "tool.updated", runId: "run-1", callId: "call-1", name: "read", output: "half", details: { progress: 0.5 } });
    turns = apply(turns, { type: "tool.completed", runId: "run-1", callId: "call-1", name: "read", output: "done", isError: false });
    turns = apply(turns, { type: "tool.started", runId: "run-1", callId: "call-2", name: "write", args: {} });
    turns = apply(turns, { type: "tool.completed", runId: "run-1", callId: "call-2", name: "write", output: "denied", isError: true });

    expect(turns[0].activities).toEqual([
      { id: "call-1", type: "tool", name: "read", args: { path: "a.ts" }, output: "done", status: "success", details: { progress: 0.5 } },
      { id: "call-2", type: "tool", name: "write", args: {}, output: "denied", status: "error" },
    ]);
  });

  it("deduplicates pending questions and applies usage and file-change updates", () => {
    const usage = {
      provider: "openai",
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      requestCount: 1,
      cost: 0.01,
    };
    const changes = [{
      id: "change-1",
      runId: "run-1",
      callId: "call-1",
      path: "/workspace/a.ts",
      relativePath: "a.ts",
      kind: "modified" as const,
      patch: "+updated",
      afterHash: "after",
      status: "pending" as const,
      revertible: true,
    }];
    let turns = [turn("initial", "Initial", "running")];
    turns = apply(turns, { type: "question.requested", runId: "run-1", callId: "question-1", question: "Old?", options: [] });
    turns = apply(turns, { type: "question.requested", runId: "run-1", callId: "question-1", question: "Continue?", options: [{ label: "Yes" }] });
    turns = apply(turns, { type: "response.usage", runId: "run-1", usage });
    turns = apply(turns, { type: "response.usage", runId: "run-1", usage: { ...usage, outputTokens: 8, totalTokens: 18, cost: 0.02 } });
    turns = apply(turns, { type: "changes.updated", runId: "run-1", changes });

    expect(turns[0].activities).toEqual([{
      id: "question-1",
      type: "question",
      question: "Continue?",
      options: [{ label: "Yes" }],
      status: "pending",
    }]);
    expect(turns[0].usage).toMatchObject({ outputTokens: 8, requestCount: 2, cost: 0.03 });
    expect(turns[0].fileChanges).toBe(changes);
  });

  it("leaves renderer-independent control events out of turn state", () => {
    const turns = [turn("initial", "Initial", "running")];
    const controls: AgentEvent[] = [
      { type: "runtime.status", status: "running" },
      { type: "context.updated", runId: "run-1", usage: { tokens: 10, contextWindow: 100, percent: 10 } },
      { type: "queue.updated", runId: "run-1", queue: { steering: ["adjust"], followUp: ["later"] } },
      { type: "agent.event", runId: "run-1", event: { sequence: 1, timestamp: 1, eventType: "agent_start", payload: {} } },
      { type: "conversation.updated", kind: "delete", reason: "deleted", conversationId: "conversation-1" },
    ];

    for (const event of controls) expect(apply(turns, event)).toBe(turns);
  });

  it("streams a plan in activity order and replaces the draft with its review", () => {
    const review = {
      id: "review-1",
      cwd: "/workspace",
      conversationId: "conversation-1",
      runId: "run-1",
      toolCallId: "call-plan",
      title: "Migration",
      status: "pending" as const,
      activeVersionId: "version-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      versions: [{ id: "version-1", number: 1, markdown: "# Full plan", contentHash: "hash", createdAt: "2026-01-01T00:00:00.000Z", annotations: [] }],
    };
    let turns = [turn("initial", "Initial", "running")];
    turns = apply(turns, { type: "plan.review.draft", runId: "run-1", draft: { runId: "run-1", toolCallId: "call-plan", title: "Mig", markdown: "# Fu" } });
    turns = apply(turns, { type: "plan.review.draft", runId: "run-1", draft: { runId: "run-1", toolCallId: "call-plan", title: "Migration", markdown: "# Full plan" } });
    turns = apply(turns, { type: "plan.review.requested", runId: "run-1", review });
    turns = apply(turns, { type: "question.requested", runId: "run-1", callId: "question-after-plan", question: "Start implementation?", options: [] });
    turns = apply(turns, { type: "plan.review.resolved", runId: "run-1", review: { ...review, status: "approved" } });

    expect(turns[0].activities).toEqual([
      expect.objectContaining({ id: "call-plan", type: "plan_review", title: "Migration", markdown: "# Full plan", status: "approved" }),
      expect.objectContaining({ id: "question-after-plan", type: "question", status: "pending" }),
    ]);
  });

  it("moves a revised plan to its new streamed position without duplicating the artifact", () => {
    const firstReview = {
      id: "review-1", cwd: "/workspace", conversationId: "conversation-1", runId: "run-1", toolCallId: "call-plan-1",
      title: "Migration", status: "changes_requested" as const, activeVersionId: "version-1",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      versions: [{ id: "version-1", number: 1, markdown: "# First", contentHash: "hash-1", createdAt: "2026-01-01T00:00:00.000Z", annotations: [], decision: "changes_requested" as const }],
    };
    const secondReview = {
      ...firstReview,
      toolCallId: "call-plan-2",
      status: "pending" as const,
      activeVersionId: "version-2",
      versions: [...firstReview.versions, { id: "version-2", number: 2, markdown: "# Revised", contentHash: "hash-2", createdAt: "2026-01-01T00:01:00.000Z", annotations: [] }],
    };
    let turns = [turn("initial", "Initial", "running")];
    turns = apply(turns, { type: "plan.review.requested", runId: "run-1", review: firstReview });
    turns = apply(turns, { type: "message.delta", runId: "run-1", text: "Revising." });
    turns = apply(turns, { type: "plan.review.draft", runId: "run-1", draft: { runId: "run-1", toolCallId: "call-plan-2", title: "Migration", markdown: "# Rev" } });
    turns = apply(turns, { type: "plan.review.requested", runId: "run-1", review: secondReview });

    expect(turns[0].activities.map((activity) => activity.type)).toEqual(["message", "plan_review"]);
    expect(turns[0].activities.at(-1)).toMatchObject({ id: "call-plan-2", type: "plan_review", markdown: "# Revised", status: "pending" });
  });
});

describe("streaming event batches", () => {
  it("coalesces adjacent deltas without changing event order", () => {
    const events: AgentEvent[] = [
      { type: "message.delta", runId: "run-1", text: "hel" },
      { type: "message.delta", runId: "run-1", text: "lo" },
      { type: "thinking.delta", runId: "run-1", text: "a" },
      { type: "thinking.delta", runId: "run-1", text: "b" },
    ];
    expect(events.every(isStreamingAgentEvent)).toBe(true);
    expect(coalesceStreamingAgentEvents(events)).toEqual([
      { type: "message.delta", runId: "run-1", text: "hello" },
      { type: "thinking.delta", runId: "run-1", text: "ab" },
    ]);
    expect(applyAgentEvents([turn("initial", "Initial", "running")], events)[0]).toMatchObject({
      answer: "hello",
      activities: [
        { type: "message", text: "hello" },
        { type: "thinking", text: "ab" },
      ],
    });
  });

  it("keeps only the latest adjacent plan draft for a tool call", () => {
    const events: AgentEvent[] = [
      { type: "plan.review.draft", runId: "run-1", draft: { runId: "run-1", toolCallId: "call-plan", title: "P", markdown: "one" } },
      { type: "plan.review.draft", runId: "run-1", draft: { runId: "run-1", toolCallId: "call-plan", title: "Plan", markdown: "one two" } },
    ];
    expect(events.every(isStreamingAgentEvent)).toBe(true);
    expect(coalesceStreamingAgentEvents(events)).toEqual([events[1]]);
  });

  it("preserves deltas around control flush boundaries and settles only the matching mixed queue on error", () => {
    const turns = [
      turn("active", "Initial", "running", "run-1"),
      { ...turn("queued-unbound", "Later", "queued"), runId: undefined },
      turn("queued-other", "Other run", "queued", "run-2"),
    ];
    const events: AgentEvent[] = [
      { type: "message.delta", runId: "run-1", text: "before " },
      { type: "queue.updated", runId: "run-1", queue: { steering: [], followUp: ["Later"] } },
      { type: "message.delta", runId: "run-1", text: "after" },
      { type: "run.error", runId: "run-1", message: "model failed" },
    ];

    const next = applyAgentEvents(turns, events);
    expect(next[0]).toMatchObject({ answer: "before after", status: "error", error: "model failed" });
    expect(next[1].status).toBe("cancelled");
    expect(next[2].status).toBe("queued");
  });

  it("preserves a flushed stream and marks matching running and queued turns when stopped", () => {
    const turns = [
      turn("active", "Initial", "running", "run-1"),
      turn("queued", "Later", "queued", "run-1"),
    ];
    const next = applyAgentEvents(turns, [
      { type: "thinking.delta", runId: "run-1", text: "checking" },
      { type: "context.updated", runId: "run-1", usage: { tokens: 20, contextWindow: 100, percent: 20 } },
      { type: "run.stopped", runId: "run-1" },
    ]);

    expect(next[0]).toMatchObject({ status: "stopped", activities: [{ type: "thinking", text: "checking" }] });
    expect(next[1].status).toBe("cancelled");
  });
});
