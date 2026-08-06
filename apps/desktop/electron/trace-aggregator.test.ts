import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentTraceEvent, ResponseUsage, SubagentRunInfo } from "../src/contracts.js";
import { AgentTraceAggregator, redactTraceValue } from "./trace-aggregator.js";
import type { TraceSpanRecord } from "./trace-model.js";

function raw(runId: string, eventType: AgentTraceEvent["eventType"], timestamp: number, payload: unknown = {}): AgentEvent {
  return { type: "agent.event", runId, event: { sequence: timestamp, timestamp, eventType, payload } };
}

const usage: ResponseUsage = {
  provider: "openai",
  model: "gpt-5",
  responseModel: "gpt-5-2026-07-01",
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 40,
  cacheWriteTokens: 0,
  totalTokens: 190,
  requestCount: 1,
  cost: 0.004,
};

describe("AgentTraceAggregator", () => {
  it("builds correlated run, turn, generation, tool and compaction spans", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    const runId = "run-1";
    trace.record({ type: "run.started", runId, conversationId: "conversation-1", provider: "openai", model: "gpt-5", cwd: "/workspace" }, { prompt: "inspect the project", captureContent: "metadata" });
    trace.record(raw(runId, "turn_start", 100));
    trace.record(raw(runId, "message_start", 110, { message: { role: "assistant" } }));
    trace.record({ type: "message.delta", runId, text: "I will inspect it." });
    trace.record({ type: "response.usage", runId, usage });
    trace.record({ type: "tool.started", runId, callId: "call-1", name: "read", args: { path: "README.md" } });
    const subagent: SubagentRunInfo = {
      id: "child-1",
      parentRunId: runId,
      parentConversationId: "conversation-1",
      toolCallId: "call-1",
      role: "reviewer",
      task: "review",
      cwd: "/workspace",
      sessionId: "child-session",
      status: "completed",
      attempt: 1,
      queuedAt: "2026-01-01T00:00:00.000Z",
      startedAt: new Date(120).toISOString(),
      updatedAt: new Date(130).toISOString(),
      completedAt: new Date(130).toISOString(),
      usage,
    };
    trace.record({ type: "tool.completed", runId, callId: "call-1", name: "read", output: "contents", isError: false, details: { backgroundSubagent: subagent } });
    trace.record(raw(runId, "compaction_start", 140));
    trace.record(raw(runId, "compaction_end", 150));
    trace.record(raw(runId, "turn_end", 160));
    trace.record({ type: "run.completed", runId });

    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(["gen_ai.chat", "execute_tool read", "agent.compaction", "agent.turn", "agent.run"]));
    const root = spans.find((span) => span.name === "agent.run")!;
    const turn = spans.find((span) => span.name === "agent.turn")!;
    const generation = spans.find((span) => span.name === "gen_ai.chat")!;
    const tool = spans.find((span) => span.name === "execute_tool read")!;
    expect(turn.parentSpanId).toBe(root.spanId);
    expect(generation.parentSpanId).toBe(turn.spanId);
    expect(tool.parentSpanId).toBe(turn.spanId);
    expect(generation.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "gen_ai.output.size": 18,
    });
    expect(tool.attributes).toMatchObject({ "agent.subagent.id": "child-1", "agent.subagent.parent_run.id": runId });
    expect(root.attributes).toMatchObject({
      "agent.run.id": runId,
      "agent.conversation.id": "conversation-1",
      "agent.input.size": 19,
      "agent.run.outcome": "success",
    });
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([root.traceId]));
  });

  it("closes every active span when a run errors and records full content only when enabled", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    trace.record({ type: "run.started", runId: "run-2", conversationId: "c", provider: "anthropic", model: "claude", cwd: "/w" }, { prompt: "secret prompt", captureContent: "full" });
    trace.record(raw("run-2", "turn_start", 10));
    trace.record(raw("run-2", "message_start", 11, { message: { role: "assistant" } }));
    trace.record({ type: "message.delta", runId: "run-2", text: "partial" });
    trace.record({ type: "tool.started", runId: "run-2", callId: "tool", name: "bash", args: { command: "pwd" } });
    trace.record({ type: "run.error", runId: "run-2", message: "provider failed" });

    expect(spans).toHaveLength(4);
    expect(spans.find((span) => span.name === "agent.run")?.attributes["agent.input"]).toBe("secret prompt");
    expect(spans.find((span) => span.name === "gen_ai.chat")?.attributes["gen_ai.output"]).toBe("partial");
    expect(spans.find((span) => span.name === "execute_tool bash")?.status.code).toBe("error");
    expect(spans.find((span) => span.name === "agent.run")?.status).toEqual({ code: "error", message: "provider failed" });
  });

  it("does not mistake user or tool-result messages for model generations", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    trace.record({ type: "run.started", runId: "run-3", conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" });
    trace.record(raw("run-3", "turn_start", 10));
    trace.record(raw("run-3", "message_start", 11, { message: { role: "user" } }));
    trace.record(raw("run-3", "message_start", 12, { message: { role: "toolResult" } }));
    trace.record(raw("run-3", "message_start", 13, { message: { role: "assistant" } }));
    trace.record({ type: "response.usage", runId: "run-3", usage });
    trace.record({ type: "run.completed", runId: "run-3" });
    expect(spans.filter((span) => span.name === "gen_ai.chat")).toHaveLength(1);
  });

  it("redacts credential fields and common inline tokens before capture", () => {
    expect(redactTraceValue({
      authorization: "Bearer visible-secret",
      nested: { api_key: "sk-abcdefghijklmnop", command: "curl '?token=secret-value'" },
    })).toEqual({
      authorization: "[REDACTED]",
      nested: { api_key: "[REDACTED]", command: "curl '?token=[REDACTED]'" },
    });
  });

  it("records question requests, retries, and cancelled runs", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    const runId = "run-4";
    trace.record({ type: "run.started", runId, conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" });
    trace.record(raw(runId, "turn_start", 10));
    trace.record(raw(runId, "turn_start", 20));
    trace.record({ type: "question.requested", runId, callId: "ask-1", question: "continue?", options: [{ label: "yes" }, { label: "no" }] });
    trace.record(raw(runId, "auto_retry_start", 30));
    trace.record(raw(runId, "auto_retry_end", 40));
    trace.record(raw(runId, "summarization_retry_attempt_start", 50));
    trace.record(raw(runId, "summarization_retry_finished", 60));
    trace.record(raw(runId, "compaction_end", 70));
    trace.record({ type: "run.stopped", runId });

    const retries = spans.filter((span) => span.name === "agent.retry");
    expect(retries).toHaveLength(2);
    expect(retries.map((span) => span.attributes["agent.retry.kind"])).toEqual(["auto_retry_start", "summarization_retry_attempt_start"]);
    const root = spans.find((span) => span.name === "agent.run")!;
    expect(root.attributes["agent.run.outcome"]).toBe("cancelled");
    expect(root.status).toEqual({ code: "error", message: "Agent run stopped" });
    const turn = spans.filter((span) => span.name === "agent.turn").at(-1)!;
    expect(turn.events).toContainEqual(expect.objectContaining({
      name: "agent.question.requested",
      attributes: expect.objectContaining({ "agent.question.option_count": 2 }),
    }));
    // The second turn_start closes the first turn; both turns are recorded.
    expect(spans.filter((span) => span.name === "agent.turn")).toHaveLength(2);
  });

  it("truncates captured generation output beyond the capture limit", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    const runId = "run-5";
    trace.record({ type: "run.started", runId, conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" }, { prompt: "", captureContent: "full" });
    trace.record(raw(runId, "message_start", 10, { message: { role: "assistant" } }));
    trace.record({ type: "message.delta", runId, text: "x".repeat(150_000) });
    trace.record({ type: "message.delta", runId, text: "more" });
    trace.record({ type: "response.usage", runId, usage });
    trace.record({ type: "run.completed", runId });

    const generation = spans.find((span) => span.name === "gen_ai.chat")!;
    expect(generation.attributes["gen_ai.output.size"]).toBe(150_004);
    expect(String(generation.attributes["gen_ai.output"])).toHaveLength(100_000);
    expect(generation.attributes["gen_ai.output.truncated"]).toBe(true);
  });

  it("ignores events without a run, non-assistant payloads, and unknown tool completions", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    trace.record({ type: "runtime.status", status: "ready" } as unknown as AgentEvent);
    trace.record({ type: "message.delta", runId: "missing", text: "ignored" });
    trace.record({ type: "run.completed", runId: "missing" });

    const runId = "run-6";
    trace.record({ type: "run.started", runId, conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" });
    trace.record(raw(runId, "message_start", 10, null));
    trace.record(raw(runId, "message_start", 11, { message: "not-an-object" }));
    trace.record(raw(runId, "turn_end", 12));
    trace.record({ type: "tool.completed", runId, callId: "unknown", name: "read", output: "", isError: false });
    trace.record({ type: "response.usage", runId, usage });
    trace.record({ type: "thinking.delta", runId, text: "hmm" });
    trace.record({ type: "run.completed", runId });

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("agent.run");
  });

  it("finishes a previous run when the same run id starts again", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    const runId = "run-7";
    trace.record({ type: "run.started", runId, conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" });
    trace.record({ type: "run.started", runId, conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" });
    trace.finishOpenRuns();

    expect(spans.filter((span) => span.name === "agent.run")).toHaveLength(2);
    expect(spans[0].status).toEqual({ code: "error", message: "Duplicate run start" });
    expect(spans[1].status.message).toBe("Application exited before the run completed");
  });

  it("omits optional subagent attributes when they are absent", () => {
    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    const runId = "run-8";
    trace.record({ type: "run.started", runId, conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" });
    trace.record({ type: "tool.started", runId, callId: "call-1", name: "subagent", args: {} });
    const subagent = {
      id: "child-1",
      parentConversationId: "c",
      toolCallId: "call-1",
      role: "reviewer",
      task: "review",
      cwd: "/w",
      sessionId: "child-session",
      status: "failed",
      startedAt: new Date(1).toISOString(),
      updatedAt: new Date(2).toISOString(),
    } as unknown as SubagentRunInfo;
    trace.record({ type: "tool.completed", runId, callId: "call-1", name: "subagent", output: "", isError: true, details: { backgroundSubagent: subagent } });
    trace.record({ type: "run.completed", runId });

    const tool = spans.find((span) => span.name === "execute_tool subagent")!;
    expect(tool.status).toEqual({ code: "error", message: "Tool execution failed" });
    expect(tool.attributes["agent.subagent.parent_run.id"]).toBeUndefined();
    expect(tool.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("redacts arrays, marks circular references, and survives unserializable arguments", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactTraceValue({ list: ["sk-abcdefghijklmnop"], circular })).toEqual({
      list: ["[REDACTED]"],
      circular: { self: "[Circular]" },
    });

    const spans: TraceSpanRecord[] = [];
    const trace = new AgentTraceAggregator({ add: (span) => spans.push(span) });
    const runId = "run-9";
    trace.record({ type: "run.started", runId, conversationId: "c", provider: "openai", model: "gpt", cwd: "/w" }, { prompt: "", captureContent: "metadata" });
    trace.record({ type: "tool.started", runId, callId: "call-1", name: "bash", args: { value: 10n } });
    trace.record({ type: "run.completed", runId });

    const tool = spans.find((span) => span.name === "execute_tool bash")!;
    expect(typeof tool.attributes["gen_ai.tool.call.arguments.sha256"]).toBe("string");
  });
});
