import { describe, expect, it } from "vitest";
import type { ResponseUsage } from "./contracts.js";
import { mergeAnswerUsage } from "./response-usage.js";

function usage(inputTokens: number, outputTokens: number, cacheReadTokens: number, cost: number): ResponseUsage {
  return {
    provider: "openai-responses-compatible",
    model: "gpt-5.6-sol",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    requestCount: 1,
    cost,
  };
}

describe("answer usage", () => {
  it("shows only the final request tokens while accumulating the whole answer cost", () => {
    const toolRequest = usage(46_000, 1_200, 200_000, 0.12);
    const finalRequest = usage(25_000, 800, 24_000, 0.08);

    expect(mergeAnswerUsage(toolRequest, finalRequest)).toEqual({
      ...finalRequest,
      requestCount: 2,
      cost: 0.2,
    });
  });
});
