import { describe, expect, it } from "vitest";
import type { ChatTurn } from "./types.js";
import {
  conversationAnnouncementSnapshot,
  conversationTurnPropsEqual,
  isNearConversationBottom,
  nextConversationAnnouncement,
  safeMarkdownHref,
  safeMarkdownTarget,
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

describe("safeMarkdownTarget", () => {
  it.each(["README.md", "./docs/guide.md#setup", "/workspace/src/main.ts", "file:///workspace/README.md", "C:\\workspace\\README.md", "D:/workspace/README.md"])(
    "classifies workspace file reference %s without resolving it in the renderer",
    (reference) => expect(safeMarkdownTarget(reference)).toEqual({ kind: "workspace-file", reference }),
  );

  it.each(["javascript:alert(1)", "data:text/html,test", "shell:open", "//example.com/file", "#section"])(
    "rejects dangerous or ambiguous reference %s",
    (reference) => expect(safeMarkdownTarget(reference)).toBeNull(),
  );
});

describe("isNearConversationBottom", () => {
  it("uses an 80px follow threshold", () => {
    expect(isNearConversationBottom(1_000, 520, 400)).toBe(true);
    expect(isNearConversationBottom(1_000, 519, 400)).toBe(false);
  });
});

describe("conversationTurnPropsEqual", () => {
  it("reuses immutable turn props but invalidates memoization for newly-bound callbacks", () => {
    const chatTurn = turn({ status: "completed" });
    const onRetry = () => undefined;
    const previous = { turn: chatTurn, running: false, workspacePath: "/workspace", onRetry };

    expect(conversationTurnPropsEqual(previous, { ...previous })).toBe(true);
    expect(conversationTurnPropsEqual(previous, { ...previous, onRetry: () => undefined })).toBe(false);
    expect(conversationTurnPropsEqual(previous, { ...previous, turn: { ...chatTurn } })).toBe(false);
    expect(conversationTurnPropsEqual(previous, { ...previous, onOpenChange: () => undefined })).toBe(false);
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
