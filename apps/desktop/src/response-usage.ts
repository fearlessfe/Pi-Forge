import type { ResponseUsage } from "./contracts.js";

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
