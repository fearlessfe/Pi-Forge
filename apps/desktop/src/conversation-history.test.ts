import { describe, expect, it } from "vitest";
import { normalizeContextUsage, normalizeHistoryTurn } from "./conversation-history.js";

describe("conversation history compatibility", () => {
  it("loads legacy turns without activity and usage fields", () => {
    expect(normalizeHistoryTurn({ id: "old", question: "hello", answer: "world" }, 0)).toEqual({
      id: "old",
      sessionEntryId: "old",
      question: "hello",
      answer: "world",
      activities: [],
      fileChanges: undefined,
      usage: undefined,
      status: "completed",
    });
  });

  it("sanitizes malformed nested history fields instead of throwing", () => {
    expect(normalizeHistoryTurn({
      activities: [null, { type: "message", text: "Checking now." }, { type: "question", question: "continue?" }, { type: "tool", name: "read" }],
      usage: { provider: "anthropic", model: "claude", inputTokens: Number.NaN },
    }, 2)).toMatchObject({
      id: "history-2",
      activities: [
        { type: "message", text: "Checking now." },
        { type: "question", options: [], status: "pending" },
        { type: "tool", name: "read", output: "", status: "error" },
      ],
      usage: { provider: "anthropic", model: "claude", inputTokens: 0, requestCount: 1 },
    });
    expect(normalizeContextUsage({ contextWindow: undefined })).toBeUndefined();
  });

  it("preserves supported activity variants and drops unsafe nested data", () => {
    const turn = normalizeHistoryTurn({
      id: "complete",
      question: 42,
      answer: null,
      activities: [
        { id: "message", type: "message", text: 42 },
        { id: "thinking", type: "thinking", text: "reasoning" },
        { id: "tool-running", type: "tool", name: "bash", status: "running", args: { command: "pwd" }, output: 17 },
        { id: "tool-success", type: "tool", name: "read", status: "success", output: "ok" },
        { type: "tool", name: 123 },
        {
          id: "question",
          type: "question",
          question: 9,
          status: "pending",
          answer: "yes",
          options: [null, { label: 7 }, { label: "Yes", description: "Continue" }, { label: "No", description: 9 }],
        },
        { type: "unknown" },
      ],
      usage: {
        provider: "openai",
        model: "gpt",
        responseModel: "gpt-2026",
        inputTokens: 10,
        outputTokens: Infinity,
        cacheReadTokens: 2,
        cacheWriteTokens: "3",
        totalTokens: 12,
        requestCount: 3,
        cost: 0.01,
      },
    }, 0);

    expect(turn).toMatchObject({
      id: "complete",
      sessionEntryId: "complete",
      question: "",
      answer: "",
      activities: [
        { id: "message", type: "message", text: "" },
        { id: "thinking", type: "thinking", text: "reasoning" },
        { id: "tool-running", type: "tool", name: "bash", status: "running", output: "" },
        { id: "tool-success", type: "tool", name: "read", status: "success", output: "ok" },
        { id: "question", type: "question", question: "Pi 需要你的回答", answer: "yes", status: "answered", options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: undefined },
        ] },
      ],
      usage: {
        responseModel: "gpt-2026",
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        totalTokens: 12,
        requestCount: 3,
        cost: 0.01,
      },
    });
  });

  it("rejects malformed usage and normalizes partial context telemetry", () => {
    expect(normalizeHistoryTurn(null, 4)).toMatchObject({ id: "history-4", activities: [], usage: undefined });
    expect(normalizeHistoryTurn({ activities: "invalid", usage: { provider: 1, model: "gpt" } }, 5)).toMatchObject({
      activities: [],
      usage: undefined,
    });
    expect(normalizeContextUsage(null)).toBeUndefined();
    expect(normalizeContextUsage({ contextWindow: -1 })).toBeUndefined();
    expect(normalizeContextUsage({ contextWindow: 128_000, tokens: Number.NaN, percent: "25" })).toEqual({
      contextWindow: 128_000,
      tokens: null,
      percent: null,
    });
    expect(normalizeContextUsage({ contextWindow: 128_000, tokens: 32_000, percent: 25 })).toEqual({
      contextWindow: 128_000,
      tokens: 32_000,
      percent: 25,
    });
  });

  it("restores safe persisted file changes for historical turns", () => {
    expect(normalizeHistoryTurn({
      fileChanges: [{
        id: "change-1",
        runId: "run-1",
        callId: "call-1",
        path: "/workspace/report.pdf",
        relativePath: "report.pdf",
        kind: "created",
        patch: "Binary or large file changed: report.pdf",
        afterHash: "hash",
        status: "accepted",
        revertible: false,
      }, { id: "unsafe" }],
    }, 0).fileChanges).toEqual([expect.objectContaining({
      id: "change-1",
      relativePath: "report.pdf",
      status: "accepted",
    })]);
  });
});
