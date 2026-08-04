import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanReviewArtifact } from "../contracts";
import { I18nProvider } from "../i18n";
import { PlanReviewPanel } from "./PlanReviewPanel";

const review: PlanReviewArtifact = {
  id: "review-1",
  cwd: "/workspace",
  conversationId: "conversation-1",
  runId: "run-1",
  toolCallId: "call-1",
  title: "Migration plan",
  status: "pending",
  activeVersionId: "version-1",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  versions: [{ id: "version-1", number: 1, markdown: "# Plan\n\n1. Add contract\n2. Add tests", contentHash: "hash", createdAt: "2026-08-03T00:00:00.000Z", annotations: [] }],
};

describe("PlanReviewPanel", () => {
  it("renders an accessible pending review without conflating tool permission", () => {
    const markup = renderToStaticMarkup(<I18nProvider><PlanReviewPanel reviews={[review]} onResolve={vi.fn()} /></I18nProvider>);
    expect(markup).toContain("Migration plan");
    expect(markup).toContain("等待审阅");
    expect(markup).toContain("批准计划不会自动批准 Shell");
    expect(markup).toContain("为此段添加批注");
    expect(markup).toContain("要求修改");
    expect(markup).toContain("批准计划");
  });

  it("renders immutable resolved feedback and version history", () => {
    const resolved: PlanReviewArtifact = {
      ...review,
      status: "changes_requested",
      versions: [{
        ...review.versions[0],
        decision: "changes_requested",
        decidedAt: "2026-08-03T00:01:00.000Z",
        annotations: [{ id: "annotation-1", anchorId: "block-2-example", quote: "Add tests", comment: "Include rollback coverage.", createdAt: "2026-08-03T00:01:00.000Z" }],
      }],
    };
    const markup = renderToStaticMarkup(<I18nProvider><PlanReviewPanel reviews={[resolved]} onResolve={vi.fn()} /></I18nProvider>);
    expect(markup).toContain("已要求修改");
    expect(markup).toContain("此版本已返回修改");
    expect(markup).not.toContain(">批准计划<");
  });
});
