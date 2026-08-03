import { describe, expect, it } from "vitest";
import {
  buildContextBudgetReport,
  createContextTokenEstimator,
  estimateContextTokens,
  stableContextValue,
} from "./context-budget.js";

describe("context budget estimation", () => {
  it("uses deterministic UTF-8 byte estimates", () => {
    expect(estimateContextTokens("")).toBe(0);
    expect(estimateContextTokens("abcd")).toBe(1);
    expect(estimateContextTokens("abcde")).toBe(2);
    expect(estimateContextTokens("上下文")).toBe(3);
  });

  it("selects local model tokenizers with an explicit fallback", () => {
    const anthropic = createContextTokenEstimator("anthropic", "claude-sonnet-4-6");
    const openai = createContextTokenEstimator("openai", "gpt-5");
    const legacyOpenai = createContextTokenEstimator("openai", "gpt-4-turbo");
    const fallback = createContextTokenEstimator("google", "gemini-3-flash-preview");
    const unconfigured = createContextTokenEstimator(undefined, undefined);

    expect(anthropic.metadata).toMatchObject({ id: "anthropic-tokenizer-v1", kind: "model-tokenizer", local: true });
    expect(openai.metadata).toMatchObject({ id: "gpt-tokenizer-o200k-v1", tokenizer: "o200k_base" });
    expect(legacyOpenai.metadata).toMatchObject({ id: "gpt-tokenizer-cl100k-v1", tokenizer: "cl100k_base" });
    expect(fallback.metadata).toMatchObject({ id: "utf8-bytes-v1", kind: "fallback", bytesPerToken: 4 });
    expect(unconfigured.metadata).toMatchObject({ id: "utf8-bytes-v1", provider: "unknown", model: "unknown" });
    expect(anthropic.count("Hello 上下文")).toBeGreaterThan(0);
    expect(openai.count("Hello 上下文")).toBeGreaterThan(0);
    expect(fallback.count("上下文")).toBe(3);
  });

  it("serializes schemas independently of object insertion order", () => {
    expect(stableContextValue({ z: 1, a: { y: true, x: false } })).toBe(
      stableContextValue({ a: { x: false, y: true }, z: 1 }),
    );
  });

  it("separates baseline and on-demand cost and only counts enabled resources", () => {
    const report = buildContextBudgetReport("/workspace", [
      {
        category: "skills",
        name: "review",
        source: "user",
        scope: "user",
        enabled: true,
        disableSupported: true,
        baselineText: "abcd",
        onDemandText: "abcdefgh",
      },
      {
        category: "prompts",
        name: "summarize",
        source: "project",
        scope: "project",
        enabled: true,
        disableSupported: false,
        onDemandText: "abcdefghijkl",
      },
      {
        category: "mcpSchemas",
        name: "disabled-server",
        source: "user",
        scope: "user",
        enabled: false,
        disableSupported: true,
        estimateStatus: "unavailable",
      },
    ]);

    expect(report).toMatchObject({
      baselineEstimatedTokens: 1,
      onDemandEstimatedTokens: 5,
      totalEstimatedTokens: 6,
      availableEstimatedTokens: 6,
      estimatedSavingsTokens: 3,
    });
    expect(report.groups.find((group) => group.category === "skills")?.items[0]).toMatchObject({
      loadMode: "mixed",
      baselineEstimatedTokens: 1,
      onDemandEstimatedTokens: 2,
      estimatedTokens: 3,
      estimatedSavingsTokens: 3,
    });
    expect(report.groups.find((group) => group.category === "mcpSchemas")?.items[0]).toMatchObject({
      enabled: false,
      estimateStatus: "unavailable",
      estimatedTokens: 0,
    });
  });
});
