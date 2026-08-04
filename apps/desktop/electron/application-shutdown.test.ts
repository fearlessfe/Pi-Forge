import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationShutdown, shutdownApplication } from "./application-shutdown.js";

afterEach(() => vi.useRealTimers());

describe("shutdownApplication", () => {
  it("waits for every service and records isolated failures", async () => {
    const completed: string[] = [];
    const result = await shutdownApplication([
      { name: "runtime", run: async () => { completed.push("runtime"); } },
      { name: "trace", run: async () => { throw new Error("flush failed"); } },
      { name: "terminal", run: () => { completed.push("terminal"); } },
    ], 1_000);

    expect(completed).toEqual(["runtime", "terminal"]);
    expect(result).toEqual({ timedOut: [], failures: [{ name: "trace", message: "flush failed" }] });
  });

  it("returns after the watchdog and identifies services still pending", async () => {
    vi.useFakeTimers();
    const shutdown = shutdownApplication([
      { name: "mcp", run: () => new Promise<void>(() => undefined) },
      { name: "browser", run: () => undefined },
    ], 250);
    await vi.advanceTimersByTimeAsync(250);

    await expect(shutdown).resolves.toEqual({ timedOut: ["mcp"], failures: [] });
  });

  it("does not mutate the returned failure snapshot when a timed-out task rejects later", async () => {
    vi.useFakeTimers();
    let rejectTask: ((error: Error) => void) | undefined;
    const lateTask = new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    });
    const shutdown = shutdownApplication([
      { name: "runtime", run: () => lateTask },
    ], 100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await shutdown;

    expect(result).toEqual({ timedOut: ["runtime"], failures: [] });
    rejectTask?.(new Error("late failure"));
    await Promise.allSettled([lateTask]);
    await Promise.resolve();

    expect(result).toEqual({ timedOut: ["runtime"], failures: [] });
  });

  it("creates an idempotent shutdown entry point", async () => {
    const run = vi.fn(async () => undefined);
    const shutdown = createApplicationShutdown([{ name: "runtime", run }], 1_000);

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ timedOut: [], failures: [] });
    expect(shutdown()).toBe(first);
    expect(run).toHaveBeenCalledOnce();
  });
});
