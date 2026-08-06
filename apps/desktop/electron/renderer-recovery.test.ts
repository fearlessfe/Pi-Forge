import { describe, expect, it } from "vitest";
import { RendererCrashGuard, RendererEventJournal, rendererCrashWindowMs } from "./renderer-recovery.js";

describe("RendererCrashGuard", () => {
  it("stops automatic reload after three crashes in one window", () => {
    const guard = new RendererCrashGuard();
    expect(guard.recordCrash(1_000)).toMatchObject({ action: "reload", count: 1 });
    expect(guard.recordCrash(2_000)).toMatchObject({ action: "reload", count: 2 });
    expect(guard.recordCrash(3_000)).toEqual({ action: "stop", count: 3, delayMs: 0 });
  });

  it("forgets old crashes and resets after a stable renderer", () => {
    const guard = new RendererCrashGuard();
    guard.recordCrash(0);
    expect(guard.recordCrash(rendererCrashWindowMs + 1)).toMatchObject({ action: "reload", count: 1 });
    guard.markStable();
    expect(guard.recordCrash(rendererCrashWindowMs + 2)).toMatchObject({ action: "reload", count: 1 });
  });

  it("deduplicates unresponsive and responsive transitions", () => {
    const guard = new RendererCrashGuard();
    expect(guard.markUnresponsive()).toBe(true);
    expect(guard.markUnresponsive()).toBe(false);
    expect(guard.markResponsive()).toBe(true);
    expect(guard.markResponsive()).toBe(false);
  });
});

describe("RendererEventJournal", () => {
  it("replays active run events and runtime status", () => {
    const journal = new RendererEventJournal();
    journal.record({ type: "runtime.status", status: "unresponsive" });
    journal.record({ type: "runtime.status", conversationId: "conversation-1", status: "running" });
    journal.record({ type: "run.started", conversationId: "conversation-1", runId: "run-1", provider: "openai", model: "model", cwd: "/tmp" });
    journal.record({ type: "message.delta", conversationId: "conversation-1", runId: "run-1", text: "hello" });
    expect(journal.snapshot()).toMatchObject({
      runtimeStatus: "unresponsive",
      runtimeStatuses: { "conversation-1": "running" },
      events: [
        { type: "run.started", runId: "run-1" },
        { type: "message.delta", text: "hello" },
      ],
    });
  });

  it("retains a just-completed run and then prunes it", () => {
    let now = 100;
    const journal = new RendererEventJournal(() => now, 10, 1_000);
    journal.record({ type: "run.started", conversationId: "conversation-1", runId: "run-1", provider: "openai", model: "model", cwd: "/tmp" });
    journal.record({ type: "run.completed", conversationId: "conversation-1", runId: "run-1" });
    expect(journal.snapshot().events).toHaveLength(2);
    now += 1_000;
    expect(journal.snapshot().events).toEqual([]);
  });

  it("bounds pathological event streams while retaining run start", () => {
    const journal = new RendererEventJournal(Date.now, 3);
    journal.record({ type: "run.started", conversationId: "conversation-1", runId: "run-1", provider: "openai", model: "model", cwd: "/tmp" });
    journal.record({ type: "user.message.started", conversationId: "conversation-1", runId: "run-1", message: "keep the recovery seed" });
    for (const text of ["a", "b", "c", "d"]) {
      journal.record({ type: "message.delta", conversationId: "conversation-1", runId: "run-1", text });
    }
    const events = journal.snapshot().events;
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("run.started");
    expect(events[1]?.type).toBe("user.message.started");
    expect(events.at(-1)).toMatchObject({ text: "d" });
  });
});
