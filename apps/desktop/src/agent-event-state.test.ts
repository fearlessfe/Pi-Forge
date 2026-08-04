import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./contracts";
import { applyAgentEvent, applyAgentEvents, coalesceStreamingAgentEvents, isStreamingAgentEvent } from "./agent-event-state";
import type { ChatTurn } from "./types";

function turn(id: string, question: string, status: ChatTurn["status"], runId = "run-1"): ChatTurn {
  return { id, runId, question, answer: "", activities: [], status };
}

function apply(turns: ChatTurn[], event: AgentEvent): ChatTurn[] {
  return applyAgentEvent(turns, event);
}

describe("applyAgentEvent queue lifecycle", () => {
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
});
