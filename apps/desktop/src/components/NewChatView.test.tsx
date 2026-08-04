import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { ContextBudgetReport } from "../contracts";
import { ContextIndicator, NewChatView, nextProjectResourceSelection } from "./NewChatView";
import { parseModelValue } from "./model-selector-value";

describe("parseModelValue", () => {
  it("accepts a complete provider and model tuple", () => {
    expect(parseModelValue('["anthropic","claude-sonnet-4-6"]')).toEqual(["anthropic", "claude-sonnet-4-6"]);
  });

  it.each(["", "not-json", "[]", '["anthropic"]', '["anthropic",""]', '{"provider":"anthropic"}'])(
    "ignores an invalid Radix Select value: %s",
    (value) => expect(parseModelValue(value)).toBeNull(),
  );
});

describe("nextProjectResourceSelection", () => {
  it("switches global inheritance to an exact one-resource project selection", () => {
    expect(nextProjectResourceSelection("inherit", "skill", "review", {
      skills: ["review", "release"],
      mcpServers: ["user:search"],
    })).toEqual({ skills: ["review"], mcpServers: [] });
  });

  it("toggles resources without discarding the rest of a custom selection", () => {
    expect(nextProjectResourceSelection("custom", "mcp", "user:search", {
      skills: ["review"],
      mcpServers: ["user:search", "user:docs"],
    })).toEqual({ skills: ["review"], mcpServers: ["user:docs"] });
  });
});

describe("NewChatView analysis presentation", () => {
  it("renders thinking content directly as response text without an analysis wrapper", () => {
    const noop = vi.fn();
    const markup = renderToStaticMarkup(<I18nProvider>
      <NewChatView
        project={null}
        turns={[{
          id: "turn-1",
          question: "Inspect the project",
          answer: "Done",
          activities: [
            { id: "thinking-1", type: "thinking", text: "## Plan\n\nI will inspect the **relevant files** first." },
            { id: "message-1", type: "message", text: "| Result | Status |\n| --- | --- |\n| Build | Done |\n\n`pnpm build`\n\n<script>alert('unsafe')</script>" },
          ],
          status: "running",
        }, {
          id: "queued-1",
          question: "Summarize the result",
          answer: "",
          activities: [],
          queueMode: "followUp",
          status: "queued",
        }]}
        modelId="test-model"
        modelProvider="anthropic"
        modelProviders={[]}
        modelSupportsImages
        resourceRevision={0}
        planReviews={[]}
        prompt=""
        attachments={{ images: [], files: [] }}
        isRunning
        queuedMessages={{ steering: [], followUp: ["Summarize the result"] }}
        onPromptChange={noop}
        onAttachmentsChange={noop}
        onAttachmentError={noop}
        onProjectChange={noop}
        onChooseWorkspace={noop}
        onOpenTerminal={noop}
        onOpenContextBudget={noop}
        onResourcesChanged={noop}
        onResolvePlanReview={async () => undefined}
        onModelChange={noop}
        onSubmit={noop}
        onStop={noop}
        onQueue={noop}
        onClearQueue={noop}
        onAcceptChanges={noop}
        onRevertChanges={noop}
        onRetry={noop}
        onForkTurn={noop}
        onAnswerQuestion={noop}
      />
    </I18nProvider>);

    expect(markup).toContain("<h2>Plan</h2>");
    expect(markup).toContain("<strong>relevant files</strong>");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<code>pnpm build</code>");
    expect(markup).not.toContain("unsafe");
    expect(markup).not.toContain("thinking-activity");
    expect(markup).not.toContain("分析过程");
    expect(markup).toContain("任务进行中");
    expect(markup).toContain("正在生成回复");
    expect(markup).toContain("停止任务");
    expect(markup).toContain("Summarize the result");
    expect(markup).toContain("稍后继续 · 等待执行");
    expect(markup).toContain("已排队 1 条消息");
  });
});

describe("ContextIndicator", () => {
  it("shows the conversation resource budget in an accessible disclosure", () => {
    const budget: ContextBudgetReport = {
      cwd: "/workspace",
      estimator: { id: "gpt-tokenizer-o200k-v1", kind: "model-tokenizer", provider: "openai", model: "gpt-5", tokenizer: "o200k_base", local: true },
      baselineEstimatedTokens: 1_600,
      systemPromptEstimatedTokens: 1_000,
      toolSchemaEstimatedTokens: 600,
      activeToolCount: 12,
      resourceBaselineEstimatedTokens: 600,
      onDemandEstimatedTokens: 800,
      totalEstimatedTokens: 2_400,
      availableEstimatedTokens: 2_400,
      estimatedSavingsTokens: 600,
      history: [],
      groups: [{
        category: "skills",
        enabledItems: 1,
        totalItems: 1,
        baselineEstimatedTokens: 600,
        onDemandEstimatedTokens: 800,
        estimatedTokens: 1_400,
        availableEstimatedTokens: 1_400,
        estimatedSavingsTokens: 600,
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
          baselineEstimatedTokens: 600,
          onDemandEstimatedTokens: 800,
          estimatedTokens: 1_400,
          estimatedSavingsTokens: 600,
        }],
      }],
    };
    const markup = renderToStaticMarkup(<I18nProvider><ContextIndicator
      usage={{ tokens: 12_000, contextWindow: 128_000, percent: 9.375 }}
      budget={budget}
      onOpenBudget={vi.fn()}
    /></I18nProvider>);

    expect(markup).toContain("<details");
    expect(markup).toContain("默认</span><strong");
    expect(markup).toContain("~1.6k");
    expect(markup).not.toContain("默认</span><strong class=\"font-mono font-semibold\">~2.4k");
    expect(markup).toContain("Skill 与 Prompt 正文按需加载");
    expect(markup).toContain("review");
    expect(markup).toContain("查看完整 Context Budget");
  });
});
