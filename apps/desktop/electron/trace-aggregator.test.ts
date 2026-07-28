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
      startedAt: new Date(120).toISOString(),
      updatedAt: new Date(130).toISOString(),
      completedAt: new Date(130).toISOString(),
      usage,
    };
    trace.record({ type: "tool.completed", runId, callId: "call-1", name: "read", output: "contents", isError: false, details: { subagent } });
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
});
