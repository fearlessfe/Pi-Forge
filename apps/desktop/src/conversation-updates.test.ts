import { describe, expect, it } from "vitest";
import type { ConversationHistoryItem, ConversationUpdatedEvent } from "./contracts.js";
import { applyConversationUpdate, isCurrentConversationRequest, replayConversationUpdates } from "./conversation-updates.js";

function conversation(id: string, updatedAt: string, overrides: Partial<ConversationHistoryItem> = {}): ConversationHistoryItem {
  return {
    id,
    title: id,
    cwd: "/workspace",
    createdAt: updatedAt,
    updatedAt,
    tags: [],
    archived: false,
    searchText: id,
    ...overrides,
  };
}

describe("conversation incremental updates", () => {
  it("upserts in server order without duplicating an already loaded item", () => {
    const updated = conversation("older", "2026-08-04T12:00:00.000Z", { title: "renamed" });
    const event: ConversationUpdatedEvent = { type: "conversation.updated", kind: "upsert", reason: "renamed", conversation: updated };
    expect(applyConversationUpdate([
      conversation("newer", "2026-08-04T11:00:00.000Z"),
      conversation("older", "2026-08-04T10:00:00.000Z"),
    ], event).map((item) => item.id)).toEqual(["older", "newer"]);
  });

  it("removes deleted and no-longer-matching search results", () => {
    const first = conversation("first", "2026-08-04T10:00:00.000Z", { tags: ["important"] });
    const deleted: ConversationUpdatedEvent = { type: "conversation.updated", kind: "delete", reason: "deleted", conversationId: first.id };
    expect(applyConversationUpdate([first], deleted, "important")).toEqual([]);

    const retagged: ConversationUpdatedEvent = {
      type: "conversation.updated",
      kind: "upsert",
      reason: "tags-changed",
      conversation: { ...first, tags: [] },
    };
    expect(applyConversationUpdate([first], retagged, "important")).toEqual([]);
  });

  it("replays only updates that raced a page or search response", () => {
    const stalePage = [conversation("first", "2026-08-04T10:00:00.000Z")];
    const updates = [
      { sequence: 1, event: { type: "conversation.updated", kind: "upsert", reason: "renamed", conversation: conversation("ignored", "2026-08-04T09:00:00.000Z") } },
      { sequence: 2, event: { type: "conversation.updated", kind: "delete", reason: "deleted", conversationId: "first" } },
      { sequence: 3, event: { type: "conversation.updated", kind: "upsert", reason: "forked", conversation: conversation("fork", "2026-08-04T12:00:00.000Z", { tags: ["match"] }) } },
    ] satisfies Array<{ sequence: number; event: ConversationUpdatedEvent }>;
    expect(replayConversationUpdates(stalePage, updates, 1, "match").map((item) => item.id)).toEqual(["fork"]);
  });

  it("rejects a late conversation detail after selection moves from A to B", () => {
    expect(isCurrentConversationRequest(1, 2, "conversation-a", "conversation-b")).toBe(false);
    expect(isCurrentConversationRequest(2, 2, "conversation-b", "conversation-b")).toBe(true);
  });
});
