import { createHash, randomBytes } from "node:crypto";
import type { AgentEvent, AgentTraceEvent, ResponseUsage, SubagentRunInfo, TraceCaptureContent } from "../src/contracts.js";
import type { SubagentRunInfo as LegacySubagentRunInfo } from "@pi-forge/runtime-contracts";
import type { TraceAttributeValue, TraceRecordContext, TraceSpanRecord, TraceSpanSink } from "./trace-model.js";

type MutableSpan = Omit<TraceSpanRecord, "endTimeUnixMs" | "status"> & {
  status?: TraceSpanRecord["status"];
  capturedOutput?: string;
  outputLength?: number;
  outputTruncated?: boolean;
};

type RunTrace = {
  traceId: string;
  root: MutableSpan;
  captureContent: TraceCaptureContent;
  activeTurn?: MutableSpan;
  activeGeneration?: MutableSpan;
  activeCompaction?: MutableSpan;
  activeRetry?: MutableSpan;
  tools: Map<string, MutableSpan>;
};

const maximumCapturedCharacters = 100_000;
const sensitiveKeys = new Set([
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "password",
  "proxy-authorization",
  "secret",
  "set-cookie",
  "token",
  "x-api-key",
]);

function id(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function redactString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

export function redactTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactTraceValue(entry, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = sensitiveKeys.has(key.toLowerCase()) ? "[REDACTED]" : redactTraceValue(entry, seen);
  }
  seen.delete(value);
  return result;
}

function stringify(value: unknown): string {
  const redacted = redactTraceValue(value);
  if (typeof redacted === "string") return redacted;
  try {
    return JSON.stringify(redacted);
  } catch {
    return String(redacted ?? "");
  }
}

function contentAttributes(prefix: string, value: unknown, mode: TraceCaptureContent): Record<string, TraceAttributeValue> {
  if (mode === "none") return {};
  const text = stringify(value);
  const attributes: Record<string, TraceAttributeValue> = {
    [`${prefix}.size`]: text.length,
    [`${prefix}.sha256`]: createHash("sha256").update(text).digest("hex"),
  };
  if (mode === "full") {
    attributes[prefix] = text.slice(0, maximumCapturedCharacters);
    if (text.length > maximumCapturedCharacters) attributes[`${prefix}.truncated`] = true;
  }
  return attributes;
}

function makeSpan(
  traceId: string,
  name: string,
  parentSpanId: string | undefined,
  kind: MutableSpan["kind"],
  timestamp: number,
  attributes: Record<string, TraceAttributeValue> = {},
): MutableSpan {
  return {
    traceId,
    spanId: id(8),
    parentSpanId,
    name,
    kind,
    startTimeUnixMs: timestamp,
    attributes,
    events: [],
  };
}

function usageAttributes(usage: ResponseUsage): Record<string, TraceAttributeValue> {
  return {
    "gen_ai.provider.name": usage.provider,
    "gen_ai.request.model": usage.model,
    ...(usage.responseModel ? { "gen_ai.response.model": usage.responseModel } : {}),
    "gen_ai.usage.input_tokens": usage.inputTokens,
    "gen_ai.usage.output_tokens": usage.outputTokens,
    "gen_ai.usage.cache_read_tokens": usage.cacheReadTokens,
    "gen_ai.usage.cache_write_tokens": usage.cacheWriteTokens,
    "gen_ai.usage.total_tokens": usage.totalTokens,
    "gen_ai.request.count": usage.requestCount,
    "gen_ai.usage.cost": usage.cost,
  };
}

function subagentAttributes(subagent: SubagentRunInfo | LegacySubagentRunInfo): Record<string, TraceAttributeValue> {
  return {
    "agent.subagent.id": subagent.id,
    "agent.subagent.session.id": subagent.sessionId,
    "agent.subagent.role": subagent.role,
    "agent.subagent.status": subagent.status,
    ...(subagent.parentRunId ? { "agent.subagent.parent_run.id": subagent.parentRunId } : {}),
    ...(subagent.usage ? usageAttributes(subagent.usage) : {}),
  };
}

export class AgentTraceAggregator {
  private readonly runs = new Map<string, RunTrace>();

  constructor(private readonly sink: TraceSpanSink) {}

  record(event: AgentEvent, context?: TraceRecordContext): void {
    const now = event.type === "agent.event" ? event.event.timestamp : Date.now();
    if (event.type === "run.started") {
      this.startRun(event, now, context);
      return;
    }
    // Runtime lifecycle and conversation-index events are not tied to a run
    // and produce no spans of their own.
    if (event.type === "runtime.status" || event.type === "conversation.updated") return;
    const run = this.runs.get(event.runId);
    if (!run) return;

    switch (event.type) {
      case "agent.event":
        this.recordRuntimeEvent(run, event.event, now);
        break;
      case "message.delta":
        this.appendOutput(run.activeGeneration, event.text);
        break;
      case "thinking.delta":
      case "tool.updated":
      case "context.updated":
      case "queue.updated":
      case "changes.updated":
        break;
      case "tool.started": {
        const parent = run.activeTurn?.spanId ?? run.root.spanId;
        const span = makeSpan(run.traceId, `execute_tool ${event.name}`, parent, "internal", now, {
          "agent.run.id": event.runId,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.call.id": event.callId,
          "gen_ai.tool.name": event.name,
          ...contentAttributes("gen_ai.tool.call.arguments", event.args, run.captureContent),
        });
        run.tools.set(event.callId, span);
        break;
      }
      case "tool.completed": {
        const span = run.tools.get(event.callId);
        if (!span) break;
        Object.assign(span.attributes, contentAttributes("gen_ai.tool.call.result", event.output, run.captureContent));
        const subagent = event.details?.backgroundSubagent ?? event.details?.subagent;
        if (subagent) Object.assign(span.attributes, subagentAttributes(subagent));
        this.finish(span, now, event.isError ? { code: "error", message: "Tool execution failed" } : { code: "ok" });
        run.tools.delete(event.callId);
        break;
      }
      case "question.requested":
        (run.activeTurn ?? run.root).events.push({
          name: "agent.question.requested",
          timeUnixMs: now,
          attributes: {
            "gen_ai.tool.call.id": event.callId,
            ...contentAttributes("agent.question", event.question, run.captureContent),
            "agent.question.option_count": event.options.length,
          },
        });
        break;
      case "response.usage":
        this.finishGeneration(run, now, event.usage);
        break;
      case "run.completed":
        this.finishRun(event.runId, now, { code: "ok" }, "success");
        break;
      case "run.stopped":
        this.finishRun(event.runId, now, { code: "error", message: "Agent run stopped" }, "cancelled");
        break;
      case "run.error": {
        const error = redactString(event.message);
        run.root.events.push({ name: "exception", timeUnixMs: now, attributes: { "exception.message": error } });
        this.finishRun(event.runId, now, { code: "error", message: error }, "error");
        break;
      }
    }
  }

  finishOpenRuns(message = "Application exited before the run completed"): void {
    const now = Date.now();
    for (const runId of [...this.runs.keys()]) this.finishRun(runId, now, { code: "error", message }, "interrupted");
  }

  private startRun(event: Extract<AgentEvent, { type: "run.started" }>, now: number, context?: TraceRecordContext): void {
    if (this.runs.has(event.runId)) this.finishRun(event.runId, now, { code: "error", message: "Duplicate run start" }, "interrupted");
    const traceId = id(16);
    const captureContent = context?.captureContent ?? "none";
    const root = makeSpan(traceId, "agent.run", undefined, "internal", now, {
      "agent.run.id": event.runId,
      "agent.conversation.id": event.conversationId,
      "agent.workspace": event.cwd,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": event.provider,
      "gen_ai.request.model": event.model,
      ...contentAttributes("agent.input", context?.prompt ?? "", captureContent),
    });
    this.runs.set(event.runId, { traceId, root, captureContent, tools: new Map() });
  }

  private recordRuntimeEvent(run: RunTrace, event: AgentTraceEvent, now: number): void {
    const eventType = event.eventType;
    if (eventType === "turn_start") {
      if (run.activeTurn) this.finish(run.activeTurn, now, { code: "ok" });
      run.activeTurn = makeSpan(run.traceId, "agent.turn", run.root.spanId, "internal", now, { "gen_ai.operation.name": "agent_turn" });
    } else if (eventType === "turn_end") {
      if (run.activeGeneration) this.finishGeneration(run, now);
      if (run.activeTurn) this.finish(run.activeTurn, now, { code: "ok" });
      run.activeTurn = undefined;
    } else if (eventType === "message_start" && this.messageRole(event.payload) === "assistant") {
      if (run.activeGeneration) this.finishGeneration(run, now);
      run.activeGeneration = makeSpan(
        run.traceId,
        "gen_ai.chat",
        run.activeTurn?.spanId ?? run.root.spanId,
        "client",
        now,
        { "gen_ai.operation.name": "chat" },
      );
    } else if (eventType === "compaction_start") {
      run.activeCompaction = makeSpan(run.traceId, "agent.compaction", run.activeTurn?.spanId ?? run.root.spanId, "internal", now);
    } else if (eventType === "compaction_end") {
      if (run.activeCompaction) this.finish(run.activeCompaction, now, { code: "ok" });
      run.activeCompaction = undefined;
    } else if (eventType === "auto_retry_start" || eventType === "summarization_retry_attempt_start") {
      run.activeRetry = makeSpan(run.traceId, "agent.retry", run.activeTurn?.spanId ?? run.root.spanId, "internal", now, { "agent.retry.kind": eventType });
    } else if (eventType === "auto_retry_end" || eventType === "summarization_retry_finished") {
      if (run.activeRetry) this.finish(run.activeRetry, now, { code: "ok" });
      run.activeRetry = undefined;
    }
  }

  private messageRole(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const message = (payload as { message?: unknown }).message;
    return message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : undefined;
  }

  private appendOutput(span: MutableSpan | undefined, delta: string): void {
    if (!span) return;
    span.outputLength = (span.outputLength ?? 0) + delta.length;
    if ((span.capturedOutput?.length ?? 0) >= maximumCapturedCharacters) {
      span.outputTruncated = true;
      return;
    }
    const remaining = maximumCapturedCharacters - (span.capturedOutput?.length ?? 0);
    span.capturedOutput = `${span.capturedOutput ?? ""}${delta.slice(0, remaining)}`;
    if (delta.length > remaining) span.outputTruncated = true;
  }

  private finishGeneration(run: RunTrace, now: number, usage?: ResponseUsage): void {
    const span = run.activeGeneration;
    if (!span) return;
    if (usage) Object.assign(span.attributes, usageAttributes(usage));
    if (run.captureContent !== "none") {
      const output = redactString(span.capturedOutput ?? "");
      span.attributes["gen_ai.output.size"] = span.outputLength ?? 0;
      span.attributes["gen_ai.output.sha256"] = createHash("sha256").update(output).digest("hex");
      if (run.captureContent === "full") span.attributes["gen_ai.output"] = output;
      if (span.outputTruncated) span.attributes["gen_ai.output.truncated"] = true;
    }
    this.finish(span, now, { code: "ok" });
    run.activeGeneration = undefined;
  }

  private finishRun(runId: string, now: number, status: TraceSpanRecord["status"], outcome: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.activeGeneration) this.finishGeneration(run, now);
    for (const span of run.tools.values()) this.finish(span, now, { code: "error", message: "Run ended before tool completion" });
    if (run.activeCompaction) this.finish(run.activeCompaction, now, status);
    if (run.activeRetry) this.finish(run.activeRetry, now, status);
    if (run.activeTurn) this.finish(run.activeTurn, now, status);
    run.root.attributes["agent.run.outcome"] = outcome;
    this.finish(run.root, now, status);
    this.runs.delete(runId);
  }

  private finish(span: MutableSpan, now: number, status: TraceSpanRecord["status"]): void {
    const { capturedOutput: _capturedOutput, outputLength: _outputLength, outputTruncated: _outputTruncated, ...record } = span;
    this.sink.add({ ...record, endTimeUnixMs: Math.max(now, span.startTimeUnixMs), status });
  }
}
