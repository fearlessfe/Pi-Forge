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
});
