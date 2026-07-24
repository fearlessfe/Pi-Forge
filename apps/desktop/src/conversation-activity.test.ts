import { describe, expect, it } from "vitest";
import type { ConversationActivity } from "./contracts.js";
import { appendMessageDelta, normalizeVisibleActivities } from "./conversation-activity.js";

describe("conversation activity ordering", () => {
  it("coalesces streaming text but starts a new reply after a tool call", () => {
    let activities: ConversationActivity[] = [];
    activities = appendMessageDelta(activities, "我先检查");
    activities = appendMessageDelta(activities, "项目。");
    activities = [...activities, {
      id: "call-read",
      type: "tool",
      name: "read",
      args: { path: "README.md" },
      output: "project readme",
      status: "success",
    }];
    activities = appendMessageDelta(activities, "检查完成。");

    expect(activities).toEqual([
      expect.objectContaining({ type: "message", text: "我先检查项目。" }),
      expect.objectContaining({ type: "tool", name: "read", status: "success" }),
      expect.objectContaining({ type: "message", text: "检查完成。" }),
    ]);
  });

  it("merges visually adjacent thinking after hidden activities are removed", () => {
    const activities: ConversationActivity[] = [
      { id: "thinking-1", type: "thinking", text: "Inspect the project." },
      { id: "hidden-question", type: "tool", name: "ask_user", args: {}, output: "", status: "success" },
      { id: "thinking-2", type: "thinking", text: "Choose the next step." },
      { id: "call-read", type: "tool", name: "read", args: {}, output: "done", status: "success" },
      { id: "thinking-3", type: "thinking", text: "Summarize the result." },
    ];

    expect(normalizeVisibleActivities(activities)).toEqual([
      { id: "thinking-1", type: "thinking", text: "Inspect the project.\n\nChoose the next step." },
      expect.objectContaining({ id: "call-read", type: "tool" }),
      { id: "thinking-3", type: "thinking", text: "Summarize the result." },
    ]);
  });
});
