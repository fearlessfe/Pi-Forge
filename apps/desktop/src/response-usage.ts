import type { ResponseUsage } from "./contracts.js";

/**
 * pi-ai reports `inputTokens` as the uncached portion of the prompt, while
 * OpenAI's input token count includes cached reads and writes. Use the latter
 * meaning in the UI so the displayed input is never smaller than its cache.
 */
export function inputTokensIncludingCache(usage: ResponseUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * Keep token counts scoped to the final model request that produced the
 * answer, while retaining the real cost of every internal tool-loop request.
 */
export function mergeAnswerUsage(current: ResponseUsage | undefined, next: ResponseUsage): ResponseUsage {
  if (!current) return { ...next, requestCount: next.requestCount || 1 };
  return {
    ...next,
    cost: current.cost + next.cost,
    requestCount: current.requestCount + (next.requestCount || 1),
  };
}
