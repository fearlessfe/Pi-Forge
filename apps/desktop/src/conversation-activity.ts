import type { ConversationActivity } from "./contracts.js";

export function appendMessageDelta(activities: ConversationActivity[], text: string): ConversationActivity[] {
  const last = activities.at(-1);
  if (last?.type !== "message") {
    return [...activities, { id: `message-${activities.length}`, type: "message", text }];
  }
  return [...activities.slice(0, -1), { ...last, text: last.text + text }];
}
