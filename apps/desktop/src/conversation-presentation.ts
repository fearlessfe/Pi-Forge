import type { ChatTurn } from "./types.js";

export const conversationFollowThreshold = 80;

export function safeMarkdownHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function isNearConversationBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = conversationFollowThreshold,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export type ConversationAnnouncementSnapshot = {
  statuses: Map<string, ChatTurn["status"]>;
  pendingQuestions: Set<string>;
};

export function conversationAnnouncementSnapshot(turns: ChatTurn[]): ConversationAnnouncementSnapshot {
  const statuses = new Map<string, ChatTurn["status"]>();
  const pendingQuestions = new Set<string>();
  for (const turn of turns) {
    statuses.set(turn.id, turn.status);
    for (const activity of turn.activities) {
      if (activity.type === "question" && activity.status === "pending") {
        pendingQuestions.add(`${turn.id}:${activity.id}`);
      }
    }
  }
  return { statuses, pendingQuestions };
}

export function nextConversationAnnouncement(
  previous: ConversationAnnouncementSnapshot,
  turns: ChatTurn[],
): "question" | "completed" | "stopped" | "error" | null {
  for (const turn of turns) {
    for (const activity of turn.activities) {
      if (activity.type === "question" && activity.status === "pending"
        && !previous.pendingQuestions.has(`${turn.id}:${activity.id}`)) return "question";
    }
  }
  for (const turn of [...turns].reverse()) {
    if (previous.statuses.get(turn.id) === turn.status) continue;
    if (turn.status === "completed" || turn.status === "stopped" || turn.status === "error") return turn.status;
  }
  return null;
}
