import type { ChatTurn } from "./types.js";

/**
 * Ordinary conversation turns are deliberately windowed below this hard DOM
 * budget. Safety-critical turns (an open diff, running turns, and every pending
 * question) are additive: the total bound is this budget plus their count.
 */
export const conversationTurnDomBudget = 48;
export const conversationTurnEstimatedHeight = 360;
export const conversationWindowOverscan = 900;
export const conversationStreamingRefreshBudgetMs = 60;
// One frame leaves enough of the 60ms end-to-end budget for React and
// variable-height Markdown layout, including a cold long-conversation commit.
export const conversationStreamingBatchDelayMs = 16;

export function conversationMountedTurnBudget(safetyTurnCount: number): number {
  return conversationTurnDomBudget + Math.max(0, Math.floor(safetyTurnCount));
}

export type ConversationTurnLayout = {
  offsets: number[];
  heights: number[];
  totalHeight: number;
};

export type ConversationWindow = {
  indices: number[];
  viewportStart: number;
  viewportEnd: number;
};

export function buildConversationTurnLayout(
  turns: Pick<ChatTurn, "id">[],
  measuredHeights: ReadonlyMap<string, number>,
  estimatedHeight = conversationTurnEstimatedHeight,
): ConversationTurnLayout {
  const offsets = new Array<number>(turns.length);
  const heights = new Array<number>(turns.length);
  let totalHeight = 0;
  for (let index = 0; index < turns.length; index += 1) {
    offsets[index] = totalHeight;
    const measured = measuredHeights.get(turns[index].id);
    const height = measured && measured > 0 ? measured : estimatedHeight;
    heights[index] = height;
    totalHeight += height;
  }
  return { offsets, heights, totalHeight };
}

function firstTurnEndingAfter(layout: ConversationTurnLayout, position: number): number {
  let low = 0;
  let high = layout.heights.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (layout.offsets[middle] + layout.heights[middle] < position) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, layout.heights.length - 1));
}

function firstTurnStartingAfter(layout: ConversationTurnLayout, position: number): number {
  let low = 0;
  let high = layout.offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (layout.offsets[middle] <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function conversationAnchorIndex(layout: ConversationTurnLayout, viewportTop: number): number {
  if (layout.heights.length === 0) return -1;
  return firstTurnEndingAfter(layout, Math.max(0, viewportTop));
}

export function buildConversationWindow(
  layout: ConversationTurnLayout,
  viewportTop: number,
  viewportHeight: number,
  pinnedIndices: readonly number[] = [],
): ConversationWindow {
  if (layout.heights.length === 0) return { indices: [], viewportStart: 0, viewportEnd: 0 };
  const overscanStart = Math.max(0, viewportTop - conversationWindowOverscan);
  const overscanEnd = Math.max(overscanStart, viewportTop + Math.max(1, viewportHeight) + conversationWindowOverscan);
  let viewportStart = firstTurnEndingAfter(layout, overscanStart);
  let viewportEnd = Math.max(viewportStart + 1, firstTurnStartingAfter(layout, overscanEnd));
  viewportEnd = Math.min(layout.heights.length, viewportEnd);

  if (viewportEnd - viewportStart > conversationTurnDomBudget) {
    const visibleAnchor = firstTurnEndingAfter(layout, viewportTop);
    const before = Math.floor(conversationTurnDomBudget / 3);
    viewportStart = Math.max(0, visibleAnchor - before);
    viewportEnd = Math.min(layout.heights.length, viewportStart + conversationTurnDomBudget);
    viewportStart = Math.max(0, viewportEnd - conversationTurnDomBudget);
  }

  const pinned = [...new Set(pinnedIndices)]
    .filter((index) => index >= 0 && index < layout.heights.length);
  const indices = new Set(pinned);
  for (let index = viewportStart; index < viewportEnd; index += 1) indices.add(index);
  return { indices: [...indices].sort((left, right) => left - right), viewportStart, viewportEnd };
}

export function pinnedConversationTurnIndices(turns: ChatTurn[], openChangeId?: string): number[] {
  const indices: number[] = [];
  const openDiffIndex = openChangeId
    ? turns.findIndex((turn) => turn.fileChanges?.some((change) => change.id === openChangeId))
    : -1;
  if (openDiffIndex >= 0) indices.push(openDiffIndex);

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].status === "running") indices.push(index);
  }
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].activities.some((activity) => activity.type === "question" && activity.status === "pending")) {
      indices.push(index);
    }
  }
  return [...new Set(indices)];
}
