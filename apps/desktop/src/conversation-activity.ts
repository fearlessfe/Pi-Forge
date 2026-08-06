import type { ConversationActivity } from "./contracts.js";

export function appendMessageDelta(activities: ConversationActivity[], text: string): ConversationActivity[] {
  const last = activities.at(-1);
  if (last?.type !== "message") {
    return [...activities, { id: `message-${activities.length}`, type: "message", text }];
  }
  return [...activities.slice(0, -1), { ...last, text: last.text + text }];
}

export function normalizeVisibleActivities(activities: ConversationActivity[]): ConversationActivity[] {
  const normalized: ConversationActivity[] = [];
  for (const activity of activities) {
    if (activity.type === "tool" && (activity.name === "ask_user" || activity.name === "request_plan_review")) continue;
    const previous = normalized.at(-1);
    if (previous?.type === "thinking" && activity.type === "thinking") {
      const separator = previous.text && activity.text ? "\n\n" : "";
      normalized[normalized.length - 1] = { ...previous, text: `${previous.text}${separator}${activity.text}` };
      continue;
    }
    normalized.push(activity);
  }
  return normalized;
}
