import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunInfo } from "../src/contracts.js";
import {
  SubagentScheduler,
  type EnqueueSubagentRun,
  type SubagentSchedulerStore,
} from "./subagent-scheduler.js";

function waitFor(predicate: () => boolean): Promise<void> {
  return vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 1_000, interval: 1 });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function waitUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

class FakeStore implements SubagentSchedulerStore {
  private readonly runs = new Map<string, SubagentRunInfo>();
  private nextId = 1;

  createOrGet(input: EnqueueSubagentRun): SubagentRunInfo {
    const existing = [...this.runs.values()].find((run) => (
      run.parentConversationId === input.parentConversationId
      && run.parentRunId === input.parentRunId
      && run.toolCallId === input.toolCallId
    ));
    if (existing) return existing;
    const now = new Date().toISOString();
    const run: SubagentRunInfo = {
      ...input,
      id: `subagent-${this.nextId++}`,
      status: "queued",
      attempt: 0,
      queuedAt: now,
      startedAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  update(id: string, patch: Partial<Omit<SubagentRunInfo, "id" | "startedAt">>): SubagentRunInfo | undefined {
    const current = this.runs.get(id);
    if (!current) return undefined;
    const run = { ...current, ...patch, id, startedAt: current.startedAt, updatedAt: new Date().toISOString() };
    this.runs.set(id, run);
    return run;
  }

  list(): SubagentRunInfo[] {
    return [...this.runs.values()];
  }

  get(id: string): SubagentRunInfo | undefined {
    return this.runs.get(id);
  }

  claimNext(): SubagentRunInfo | undefined {
    const queued = this.list().find((run) => run.status === "queued");
    if (!queued) return undefined;
    return this.update(queued.id, {
      status: "running",
      attempt: queued.attempt + 1,
      completedAt: undefined,
      error: undefined,
    });
  }

  pause(id: string): SubagentRunInfo | undefined {
    const run = this.get(id);
    if (!run || (run.status !== "queued" && run.status !== "running")) return undefined;
    return this.update(id, { status: "paused" });
  }

  resume(id: string): SubagentRunInfo | undefined {
    const run = this.get(id);
    if (run?.status !== "paused") return undefined;
    return this.update(id, { status: "queued", queuedAt: new Date().toISOString() });
  }

  retry(id: string): SubagentRunInfo | undefined {
    const run = this.get(id);
    if (run?.status !== "error") return undefined;
    return this.update(id, { status: "queued", queuedAt: new Date().toISOString(), completedAt: undefined, error: undefined });
  }

  stop(id: string): SubagentRunInfo | undefined {
    const run = this.get(id);
    if (!run || run.status === "completed" || run.status === "stopped") return undefined;
    return this.update(id, { status: "stopped", completedAt: new Date().toISOString() });
  }

  complete(id: string, result: { result?: string; usage?: SubagentRunInfo["usage"] }): SubagentRunInfo | undefined {
    return this.update(id, { ...result, status: "completed", completedAt: new Date().toISOString(), error: undefined });
  }

  fail(id: string, error: string, usage?: SubagentRunInfo["usage"]): SubagentRunInfo | undefined {
    return this.update(id, { status: "error", completedAt: new Date().toISOString(), error, usage });
  }

  recoverInterrupted(): void {
    for (const run of this.runs.values()) {
      if (run.status === "running") this.update(run.id, { status: "queued", queuedAt: new Date().toISOString() });
    }
  }
}

const schedulers: SubagentScheduler[] = [];

function createScheduler(store: FakeStore, execute: ConstructorParameters<typeof SubagentScheduler>[1]): SubagentScheduler {
  const scheduler = new SubagentScheduler(store, execute);
  schedulers.push(scheduler);
  return scheduler;
}

function input(toolCallId: string): EnqueueSubagentRun {
  return {
    toolCallId,
    role: "reviewer",
    task: `Review ${toolCallId}`,
    cwd: "/workspace",
    sessionId: `session-${toolCallId}`,
    parentConversationId: "parent-conversation",
    parentRunId: "parent-run",
  };
}

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.dispose();
});

describe("SubagentScheduler", () => {
  it("deduplicates a replayed parent tool call before scheduling", async () => {
    const store = new FakeStore();
    const execute = vi.fn(async () => ({ result: "once" }));
    const scheduler = createScheduler(store, execute);

    const first = scheduler.enqueue(input("replayed"));
    const replay = scheduler.enqueue({ ...input("replayed"), sessionId: "replacement-session" });

    expect(replay.id).toBe(first.id);
    await waitFor(() => store.get(first.id)?.status === "completed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns immediately, processes durable work in the background, and emits lifecycle updates", async () => {
    const store = new FakeStore();
    let finish: (() => void) | undefined;
    const events: string[] = [];
    const scheduler = createScheduler(store, async (_run, _signal, onUpdate) => {
      onUpdate({ result: "partial" });
      await new Promise<void>((resolve) => { finish = resolve; });
      return { result: "complete" };
    });
    scheduler.subscribe((event) => events.push(`${event.run.status}:${event.run.result ?? ""}`));

    const run = scheduler.enqueue(input("background"));
    expect(run.status).toBe("queued");
    await waitFor(() => store.get(run.id)?.result === "partial");
    expect(store.get(run.id)?.status).toBe("running");

    finish?.();
    await waitFor(() => store.get(run.id)?.status === "completed");
    expect(store.get(run.id)).toMatchObject({ attempt: 1, result: "complete" });
    expect(events).toEqual(expect.arrayContaining(["queued:", "running:", "running:partial", "completed:complete"]));
  });

  it("uses one execution slot while preserving queue order", async () => {
    const store = new FakeStore();
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const scheduler = createScheduler(store, async (run) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(run.toolCallId);
      await Promise.resolve();
      active -= 1;
      return { result: run.toolCallId };
    });

    const first = scheduler.enqueue(input("first"));
    const second = scheduler.enqueue(input("second"));
    await waitFor(() => store.get(second.id)?.status === "completed");

    expect(store.get(first.id)?.status).toBe("completed");
    expect(order).toEqual(["first", "second"]);
    expect(maximumActive).toBe(1);
  });

  it("pauses an active run and resumes it as a new attempt", async () => {
    const store = new FakeStore();
    const attempts: number[] = [];
    const scheduler = createScheduler(store, async (run, signal) => {
      attempts.push(run.attempt);
      if (run.attempt === 1) return waitUntilAborted(signal);
      return { result: "resumed" };
    });

    const run = scheduler.enqueue(input("pause-resume"));
    await waitFor(() => attempts.length === 1);
    expect(scheduler.pause(run.id)?.status).toBe("paused");
    expect(scheduler.resume(run.id)?.status).toBe("queued");

    await waitFor(() => store.get(run.id)?.status === "completed");
    expect(store.get(run.id)).toMatchObject({ attempt: 2, result: "resumed", error: undefined });
    expect(attempts).toEqual([1, 2]);
  });

  it("persists execution errors and retries failed work", async () => {
    const store = new FakeStore();
    const scheduler = createScheduler(store, async (run) => {
      if (run.attempt === 1) throw new Error("provider unavailable");
      return { result: "retried" };
    });

    const run = scheduler.enqueue(input("retry"));
    await waitFor(() => store.get(run.id)?.status === "error");
    expect(store.get(run.id)?.error).toBe("provider unavailable");
    expect(scheduler.retry(run.id)?.status).toBe("queued");

    await waitFor(() => store.get(run.id)?.status === "completed");
    expect(store.get(run.id)).toMatchObject({ attempt: 2, result: "retried", error: undefined });
  });

  it("aborts on dispose without recording failure and drains recovered work after restart", async () => {
    const store = new FakeStore();
    const first = createScheduler(store, async (_run, signal) => waitUntilAborted(signal));
    const run = first.enqueue(input("restart"));
    await waitFor(() => store.get(run.id)?.status === "running");

    first.dispose();
    await Promise.resolve();
    expect(store.get(run.id)).toMatchObject({ status: "running", error: undefined });

    store.recoverInterrupted();
    createScheduler(store, async () => ({ result: "recovered" }));
    await waitFor(() => store.get(run.id)?.status === "completed");
    expect(store.get(run.id)).toMatchObject({ attempt: 2, result: "recovered", error: undefined });
  });

  it("stops an active run without allowing its abort rejection to overwrite state", async () => {
    const store = new FakeStore();
    const scheduler = createScheduler(store, async (_run, signal) => waitUntilAborted(signal));
    const run = scheduler.enqueue(input("stop"));
    await waitFor(() => store.get(run.id)?.status === "running");

    expect(scheduler.stop(run.id)?.status).toBe("stopped");
    await Promise.resolve();
    expect(store.get(run.id)).toMatchObject({ status: "stopped", error: undefined });
  });
});
