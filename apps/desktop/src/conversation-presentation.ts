import type { ChatTurn } from "./types.js";

export const conversationFollowThreshold = 80;

/**
 * React.memo's default shallow comparison is the desired contract for a turn:
 * immutable turn data may be reused, but a newly-bound action callback must
 * never leave the rendered turn invoking a stale conversation handler.
 */
export function conversationTurnPropsEqual(previous: object, next: object): boolean {
  if (previous === next) return true;
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  const nextKeys = Object.keys(nextRecord);
  return previousKeys.length === nextKeys.length
    && previousKeys.every((key) => Object.is(previousRecord[key], nextRecord[key]));
}

export type SafeMarkdownTarget =
  | { kind: "web"; href: string }
  | { kind: "workspace-file"; reference: string };

export function safeMarkdownTarget(href: string | undefined): SafeMarkdownTarget | null {
  if (!href) return null;
  const reference = href.trim();
  if (!reference || /[\0\r\n]/.test(reference)) return null;
  if (/^[a-z]:[\\/]/i.test(reference)) return { kind: "workspace-file", reference };
  try {
    const parsed = new URL(reference);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return { kind: "web", href: parsed.href };
    }
    if (parsed.protocol === "file:") return { kind: "workspace-file", reference };
    return null;
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference)
      || reference.startsWith("//")
      || reference.startsWith("#")
      || reference.startsWith("?")) return null;
    return { kind: "workspace-file", reference };
  }
}

export function safeMarkdownHref(href: string | undefined): string | null {
  const target = safeMarkdownTarget(href);
  return target?.kind === "web" ? target.href : null;
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
