import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planReviewBlocks } from "../src/plan-review.js";
import { PlanReviewStore } from "./plan-review-store.js";

function directory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-review-"));
}

describe("PlanReviewStore", () => {
  it("persists decisions and creates a new content-bound version", () => {
    const root = directory();
    const store = new PlanReviewStore(root);
    const first = store.request({ cwd: root, conversationId: "conversation-1", runId: "run-1", toolCallId: "call-1", title: "Migration", markdown: "# Plan\n\nFirst step" });
    const version = first.versions[0];
    const resolved = store.resolve({ reviewId: first.id, versionId: version.id, decision: "changes_requested", annotations: [{ anchorId: planReviewBlocks(version.markdown)[1].id, quote: "ignored", comment: "Add rollback." }] });

    expect(resolved.status).toBe("changes_requested");
    expect(resolved.versions[0].annotations[0]).toMatchObject({ quote: "First step", comment: "Add rollback." });
    const second = store.request({ cwd: root, conversationId: "conversation-1", runId: "run-2", toolCallId: "call-2", title: "Migration", markdown: "# Plan\n\nFirst step\n\nRollback" });
    expect(second).toMatchObject({ id: first.id, status: "pending" });
    expect(second.versions).toHaveLength(2);
    expect(new PlanReviewStore(root).list("conversation-1")[0]).toEqual(second);
  });

  it("requires an anchored comment when requesting changes", () => {
    const root = directory();
    const store = new PlanReviewStore(root);
    const review = store.request({ cwd: root, conversationId: "conversation-1", runId: "run-1", toolCallId: "call-1", title: "Plan", markdown: "One step" });
    expect(() => store.resolve({ reviewId: review.id, versionId: review.activeVersionId, decision: "changes_requested", annotations: [] })).toThrow("至少需要一条批注");
  });
});
