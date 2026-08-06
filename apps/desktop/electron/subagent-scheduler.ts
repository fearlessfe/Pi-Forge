import type {
  BackgroundSubagentRunInfo as SubagentRunInfo,
  EnqueueSubagentInput,
  ResponseUsage,
} from "@pi-forge/runtime-contracts";

export type EnqueueSubagentRun = EnqueueSubagentInput & { sessionId: string };

export type SubagentExecutionResult = {
  result?: string;
  usage?: ResponseUsage;
};

export type SubagentProgressUpdate = Pick<SubagentExecutionResult, "result" | "usage">;

export type SubagentExecutor = (
  run: SubagentRunInfo,
  signal: AbortSignal,
  onUpdate: (update: SubagentProgressUpdate) => void,
) => Promise<SubagentExecutionResult>;

export type SubagentSchedulerEvent = {
  type: "run.changed";
  run: SubagentRunInfo;
};

export type SubagentSchedulerListener = (event: SubagentSchedulerEvent) => void;

/**
 * The scheduler intentionally depends on a structural store contract. The Main
 * process can own the concrete persistent store without leaking filesystem
 * details into the execution runtime.
 */
export interface SubagentSchedulerStore {
  createOrGet(input: EnqueueSubagentRun): SubagentRunInfo;
  update(id: string, patch: SubagentProgressUpdate): SubagentRunInfo | undefined;
  list(): SubagentRunInfo[];
  get(id: string): SubagentRunInfo | undefined;
  claimNext(): SubagentRunInfo | undefined;
  pause(id: string): SubagentRunInfo | undefined;
  resume(id: string): SubagentRunInfo | undefined;
  retry(id: string): SubagentRunInfo | undefined;
  stop(id: string, error?: string): SubagentRunInfo | undefined;
  complete(id: string, result: SubagentExecutionResult): SubagentRunInfo | undefined;
  fail(id: string, error: string, usage?: ResponseUsage): SubagentRunInfo | undefined;
}

type ActiveExecution = {
  runId: string;
  controller: AbortController;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Drains durable Subagent work independently from the parent tool call.
 *
 * The store owns all state transitions and restart recovery. This class owns a
 * single execution slot and cancellation. In particular, dispose aborts the
 * in-memory executor but deliberately leaves the durable run as `running`; the
 * store turns an interrupted run back into `queued` when it is reopened.
 */
export class SubagentScheduler {
  private readonly listeners = new Set<SubagentSchedulerListener>();
  private active?: ActiveExecution;
  private drainScheduled = false;
  private disposed = false;

  constructor(
    private readonly store: SubagentSchedulerStore,
    private readonly execute: SubagentExecutor,
  ) {
    this.scheduleDrain();
  }

  list(): SubagentRunInfo[] {
    return this.store.list();
  }

  get(id: string): SubagentRunInfo | undefined {
    return this.store.get(id);
  }

  enqueue(input: EnqueueSubagentRun): SubagentRunInfo {
    this.assertActive();
    const run = this.store.createOrGet(input);
    this.emit(run);
    this.scheduleDrain();
    return run;
  }

  pause(id: string): SubagentRunInfo | undefined {
    this.assertActive();
    const run = this.store.pause(id);
    if (!run) return undefined;
    this.emit(run);
    if (this.active?.runId === id) this.active.controller.abort();
    return run;
  }

  resume(id: string): SubagentRunInfo | undefined {
    this.assertActive();
    const run = this.store.resume(id);
    if (!run) return undefined;
    this.emit(run);
    this.scheduleDrain();
    return run;
  }

  retry(id: string): SubagentRunInfo | undefined {
    this.assertActive();
    const run = this.store.retry(id);
    if (!run) return undefined;
    this.emit(run);
    this.scheduleDrain();
    return run;
  }

  stop(id: string): SubagentRunInfo | undefined {
    this.assertActive();
    const run = this.store.stop(id);
    if (!run) return undefined;
    this.emit(run);
    if (this.active?.runId === id) this.active.controller.abort();
    return run;
  }

  subscribe(listener: SubagentSchedulerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.active?.controller.abort();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Subagent scheduler is disposed.");
  }

  private scheduleDrain(): void {
    if (this.disposed || this.drainScheduled || this.active) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.disposed || this.active) return;
    const run = this.store.claimNext();
    if (!run) return;

    const controller = new AbortController();
    const execution = { runId: run.id, controller };
    this.active = execution;
    this.emit(run);
    void this.run(execution, run);
  }

  private async run(execution: ActiveExecution, run: SubagentRunInfo): Promise<void> {
    try {
      const outcome = await this.execute(run, execution.controller.signal, (update) => {
        if (this.disposed || execution.controller.signal.aborted || this.active !== execution) return;
        const current = this.store.get(run.id);
        if (current?.status !== "running") return;
        const updated = this.store.update(run.id, update);
        if (updated) this.emit(updated);
      });

      if (this.disposed || execution.controller.signal.aborted || this.active !== execution) return;
      const current = this.store.get(run.id);
      if (current?.status !== "running") return;
      const completed = this.store.complete(run.id, outcome);
      if (completed) this.emit(completed);
    } catch (error) {
      if (this.disposed || execution.controller.signal.aborted || this.active !== execution) return;
      const current = this.store.get(run.id);
      if (current?.status !== "running") return;
      const failed = this.store.fail(run.id, errorMessage(error));
      if (failed) this.emit(failed);
    } finally {
      if (this.active === execution) this.active = undefined;
      this.scheduleDrain();
    }
  }

  private emit(run: SubagentRunInfo): void {
    const event = { type: "run.changed", run } as const;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A renderer/event consumer must not break durable queue processing.
      }
    }
  }
}
