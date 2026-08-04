import type { ConversationHistoryItem, ConversationUpdatedEvent } from "./contracts.js";

export type SequencedConversationUpdate = {
  sequence: number;
  event: ConversationUpdatedEvent;
};

export function conversationMatchesQuery(item: ConversationHistoryItem, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || [item.title, item.cwd, item.searchText, ...item.tags]
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function applyConversationUpdate(
  items: ConversationHistoryItem[],
  event: ConversationUpdatedEvent,
  query = "",
): ConversationHistoryItem[] {
  const remaining = items.filter((item) => item.id !== (event.kind === "delete" ? event.conversationId : event.conversation.id));
  if (event.kind === "delete" || !conversationMatchesQuery(event.conversation, query)) return remaining;
  return [event.conversation, ...remaining].sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  ));
}

export function replayConversationUpdates(
  items: ConversationHistoryItem[],
  updates: readonly SequencedConversationUpdate[],
  afterSequence: number,
  query = "",
): ConversationHistoryItem[] {
  return updates.reduce((current, update) => update.sequence > afterSequence
    ? applyConversationUpdate(current, update.event, query)
    : current, items);
}

export function isCurrentConversationRequest(
  request: number,
  currentRequest: number,
  conversationId: string,
  selectedConversationId: string | null,
): boolean {
  return request === currentRequest && conversationId === selectedConversationId;
}
