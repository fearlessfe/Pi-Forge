import type { AgentEvent, AgentRuntimeStatus, RendererRecoverySnapshot } from "../src/contracts.js";

export const rendererCrashWindowMs = 60_000;
export const rendererStableWindowMs = 30_000;
export const rendererUnresponsiveGraceMs = 10_000;

export type RendererCrashDecision = {
  action: "reload" | "stop";
  count: number;
  delayMs: number;
};

/** Pure crash-loop state; Electron dialogs, timers, and reloads stay in main.ts. */
export class RendererCrashGuard {
  private crashes: number[] = [];
  private unresponsive = false;

  recordCrash(now = Date.now()): RendererCrashDecision {
    this.crashes = this.crashes.filter((timestamp) => now - timestamp < rendererCrashWindowMs);
    this.crashes.push(now);
    const count = this.crashes.length;
    return count >= 3
      ? { action: "stop", count, delayMs: 0 }
      : { action: "reload", count, delayMs: count === 1 ? 250 : 1_000 };
  }

  markStable(): void {
    this.crashes = [];
  }

  markUnresponsive(): boolean {
    if (this.unresponsive) return false;
    this.unresponsive = true;
    return true;
  }

  markResponsive(): boolean {
    if (!this.unresponsive) return false;
    this.unresponsive = false;
    return true;
  }

  isUnresponsive(): boolean {
    return this.unresponsive;
  }
}

type Journal = { events: AgentEvent[]; completedAt?: number };

/**
 * Keeps enough main-owned state to rebuild an active renderer after reload.
 * Completed runs are retained briefly so a crash racing their terminal event is
 * also recoverable. The journal is bounded to avoid unbounded main-process use.
 */
export class RendererEventJournal {
  private readonly runs = new Map<string, Journal>();
  private runtimeStatus: AgentRuntimeStatus | undefined;
  private readonly runtimeStatuses = new Map<string, AgentRuntimeStatus>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEventsPerConversation = 2_000,
    private readonly completedRetentionMs = 60_000,
  ) {}

  record(event: AgentEvent): void {
    const conversationId = "conversationId" in event && typeof event.conversationId === "string"
      ? event.conversationId
      : undefined;
    if (event.type === "runtime.status") {
      if (conversationId) this.runtimeStatuses.set(conversationId, event.status);
      else this.runtimeStatus = event.status;
    }
    if (!conversationId || event.type === "conversation.updated" || event.type === "runtime.status") return;

    if (event.type === "run.started") this.runs.set(conversationId, { events: [] });
    const journal = this.runs.get(conversationId);
    if (!journal) return;
    journal.events.push(event);
    if (journal.events.length > this.maxEventsPerConversation) {
      // Keep run.started plus every user-message boundary: a fresh renderer
      // needs those events to seed turns before it can apply later deltas.
      const removableIndex = journal.events.findIndex((entry, index) => index > 0 && entry.type !== "user.message.started");
      if (removableIndex >= 0) journal.events.splice(removableIndex, 1);
    }
    if (event.type === "run.completed" || event.type === "run.error" || event.type === "run.stopped") {
      journal.completedAt = this.now();
    }
  }

  snapshot(): RendererRecoverySnapshot {
    this.prune();
    return {
      events: [...this.runs.values()].flatMap((journal) => journal.events),
      ...(this.runtimeStatus ? { runtimeStatus: this.runtimeStatus } : {}),
      runtimeStatuses: Object.fromEntries(this.runtimeStatuses),
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [conversationId, journal] of this.runs) {
      if (journal.completedAt !== undefined && now - journal.completedAt >= this.completedRetentionMs) {
        this.runs.delete(conversationId);
      }
    }
  }
}
