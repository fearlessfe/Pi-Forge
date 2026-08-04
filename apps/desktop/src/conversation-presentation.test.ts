import { describe, expect, it } from "vitest";
import type { ChatTurn } from "./types.js";
import {
  conversationAnnouncementSnapshot,
  isNearConversationBottom,
  nextConversationAnnouncement,
  safeMarkdownHref,
} from "./conversation-presentation.js";

function turn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "turn-1",
    question: "Question",
    answer: "",
    activities: [],
    status: "running",
    ...overrides,
  };
}

describe("safeMarkdownHref", () => {
  it("allows absolute HTTP(S) links and normalizes them", () => {
    expect(safeMarkdownHref("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeMarkdownHref("http://localhost:4173")).toBe("http://localhost:4173/");
  });

  it.each(["javascript:alert(1)", "file:///tmp/secret", "data:text/html,test", "../README.md", "#section", undefined])(
    "rejects unsafe or non-web href %s",
    (href) => expect(safeMarkdownHref(href)).toBeNull(),
  );
});

describe("isNearConversationBottom", () => {
  it("uses an 80px follow threshold", () => {
    expect(isNearConversationBottom(1_000, 520, 400)).toBe(true);
    expect(isNearConversationBottom(1_000, 519, 400)).toBe(false);
  });
});

describe("nextConversationAnnouncement", () => {
  it("announces a newly requested answer without announcing existing history", () => {
    const initial = [turn()];
    const snapshot = conversationAnnouncementSnapshot(initial);
    expect(nextConversationAnnouncement(snapshot, initial)).toBeNull();
    expect(nextConversationAnnouncement(snapshot, [turn({
      activities: [{ id: "question-1", type: "question", question: "Proceed?", options: [], status: "pending" }],
    })])).toBe("question");
  });

  it.each(["completed", "stopped", "error"] as const)("announces a terminal %s transition", (status) => {
    const snapshot = conversationAnnouncementSnapshot([turn()]);
    expect(nextConversationAnnouncement(snapshot, [turn({ status })])).toBe(status);
  });
});
