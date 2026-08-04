import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContextBudgetReport } from "../contracts";
import { I18nProvider } from "../i18n";
import { ContextBudgetReportView, heaviestContextBudgetItems } from "./ContextBudgetPanel";

const report: ContextBudgetReport = {
  cwd: "/workspace",
  estimator: { id: "gpt-tokenizer-o200k-v1", kind: "model-tokenizer", provider: "openai", model: "gpt-5", tokenizer: "o200k_base", local: true },
  baselineEstimatedTokens: 120,
  onDemandEstimatedTokens: 80,
  totalEstimatedTokens: 200,
  availableEstimatedTokens: 260,
  estimatedSavingsTokens: 150,
  history: [],
  groups: [
    {
      category: "skills",
      enabledItems: 1,
      totalItems: 2,
      baselineEstimatedTokens: 40,
      onDemandEstimatedTokens: 60,
      estimatedTokens: 100,
      availableEstimatedTokens: 160,
      estimatedSavingsTokens: 100,
      items: [{
        id: "skills:user:review",
        category: "skills",
        name: "review",
        source: "user",
        scope: "user",
        enabled: true,
        disableSupported: true,
        loadMode: "mixed",
        estimateStatus: "estimated",
        baselineEstimatedTokens: 40,
        onDemandEstimatedTokens: 60,
        estimatedTokens: 100,
        estimatedSavingsTokens: 100,
      }, {
        id: "skills:user:legacy",
        category: "skills",
        name: "legacy",
        source: "user",
        scope: "user",
        enabled: false,
        disableSupported: true,
        loadMode: "on-demand",
        estimateStatus: "estimated",
        baselineEstimatedTokens: 0,
        onDemandEstimatedTokens: 60,
        estimatedTokens: 60,
        estimatedSavingsTokens: 0,
      }],
    },
    {
      category: "mcpSchemas",
      enabledItems: 1,
      totalItems: 1,
      baselineEstimatedTokens: 0,
      onDemandEstimatedTokens: 0,
      estimatedTokens: 0,
      availableEstimatedTokens: 0,
      estimatedSavingsTokens: 0,
      items: [{
        id: "mcpSchemas:user:offline",
        category: "mcpSchemas",
        name: "Offline MCP",
        source: "MCP",
        scope: "user",
        enabled: true,
        disableSupported: true,
        loadMode: "baseline",
        estimateStatus: "unavailable",
        baselineEstimatedTokens: 0,
        onDemandEstimatedTokens: 0,
        estimatedTokens: 0,
        estimatedSavingsTokens: 0,
      }],
    },
  ],
};

describe("ContextBudgetReportView", () => {
  it("renders totals, enabled state, savings, and unavailable schemas", () => {
    const markup = renderToStaticMarkup(<I18nProvider><ContextBudgetReportView report={report} /></I18nProvider>);

    expect(markup).toContain("~200");
    expect(markup).toContain("默认上下文");
    expect(markup).toContain("潜在总量");
    expect(markup).toContain("review");
    expect(markup).not.toContain("legacy");
    expect(markup).toContain("禁用默认节省 ~40");
    expect(markup).toContain("另有按需 ~60");
    expect(markup).toContain("Offline MCP");
    expect(markup).toContain("暂无法估算");
  });

  it("sorts the heaviest resources deterministically", () => {
    expect(heaviestContextBudgetItems(report).map((item) => item.name)).toEqual(["review", "Offline MCP"]);
  });
});
