import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { NewChatView } from "./NewChatView";

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
        }]}
        modelId="test-model"
        modelProvider="anthropic"
        modelProviders={[]}
        prompt=""
        isRunning
        queuedMessages={{ steering: [], followUp: [] }}
        onPromptChange={noop}
        onProjectChange={noop}
        onChooseWorkspace={noop}
        onOpenTerminal={noop}
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
  });
});
