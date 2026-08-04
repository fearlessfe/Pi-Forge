import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdownApplication } from "./application-shutdown.js";

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
});
