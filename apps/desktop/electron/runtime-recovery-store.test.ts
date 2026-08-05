import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeRecoveryStore } from "./runtime-recovery-store.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-recovery-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("RuntimeRecoveryStore", () => {
  it("turns an unfinished run into an interrupted recovery after restart", () => {
    const directory = temporaryDirectory();
    const first = new RuntimeRecoveryStore(directory);
    const pending = first.begin({ prompt: "finish the migration", cwd: "/workspace", conversationId: "conversation-1" });
    first.attachRun(pending.id, "run-1");

    const restored = new RuntimeRecoveryStore(directory).list();

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: pending.id,
      runId: "run-1",
      status: "interrupted",
      input: { prompt: "finish the migration", cwd: "/workspace", conversationId: "conversation-1" },
    });
    expect(restored[0].message).toContain("上次退出");
  });

  it("removes completed runs and explicitly discarded recoveries", () => {
    const directory = temporaryDirectory();
    const store = new RuntimeRecoveryStore(directory);
    const completed = store.begin({ prompt: "completed" });
    store.attachRun(completed.id, "run-completed");
    store.completeRun("run-completed");

    const interrupted = store.begin({ prompt: "interrupted" });
    store.interruptRecord(interrupted.id, "runtime exited");
    expect(store.list()).toEqual([expect.objectContaining({ id: interrupted.id, status: "interrupted" })]);

    store.discard(interrupted.id);
    expect(store.list()).toEqual([]);
    expect(() => store.discard(interrupted.id)).toThrow("找不到待恢复任务");
  });

  it("ignores malformed recovery files instead of preventing startup", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "runtime-recovery.json"), "{broken", "utf8");

    expect(new RuntimeRecoveryStore(directory).list()).toEqual([]);
  });

  it("filters invalid records and normalizes valid persisted fields", () => {
    const directory = temporaryDirectory();
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(directory, "runtime-recovery.json"), JSON.stringify({
      version: 1,
      records: [
        null,
        {},
        { id: "bad-input", input: { prompt: 3 }, status: "running", attempts: 1, startedAt: now, updatedAt: now },
        { id: "bad-status", input: { prompt: "x" }, status: "done", attempts: 1, startedAt: now, updatedAt: now },
        { id: "bad-attempts", input: { prompt: "x" }, status: "running", attempts: "1", startedAt: now, updatedAt: now },
        { id: "bad-start", input: { prompt: "x" }, status: "running", attempts: 1, startedAt: 1, updatedAt: now },
        { id: "bad-update", input: { prompt: "x" }, status: "running", attempts: 1, startedAt: now, updatedAt: 1 },
        { id: "valid", input: { prompt: "x" }, status: "interrupted", attempts: 0, startedAt: now, updatedAt: now },
      ],
    }), "utf8");

    const store = new RuntimeRecoveryStore(directory);
    expect(store.list()).toEqual([expect.objectContaining({ id: "valid", attempts: 1, runId: undefined, message: undefined })]);
    expect(store.get("valid").input).toEqual({ prompt: "x" });
    expect(() => store.get("missing")).toThrow("找不到待恢复任务");
  });

  it("leaves unrelated and already interrupted records unchanged", () => {
    const directory = temporaryDirectory();
    const store = new RuntimeRecoveryStore(directory);
    const first = store.begin({ prompt: " first " });
    const second = store.begin({ prompt: "second" });
    store.attachRun(first.id, "run-first");
    store.attachRun(second.id, "run-second");

    store.interruptRun("run-first", "first failed");
    store.interruptRun("run-first", "duplicate");
    store.completeRun("missing-run");
    store.attachRun("missing-id", "missing-run");

    expect(store.get(first.id)).toMatchObject({ status: "interrupted", message: "first failed", input: { prompt: "first" } });
    expect(new RuntimeRecoveryStore(directory).list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, message: "first failed" }),
      expect.objectContaining({ id: second.id, status: "interrupted" }),
    ]));
  });

  it("discards only recovery records owned by one conversation", () => {
    const store = new RuntimeRecoveryStore(temporaryDirectory());
    const first = store.begin({ prompt: "first", conversationId: "a" });
    const second = store.begin({ prompt: "second", conversationId: "b" });
    store.interruptRecord(first.id, "failed");
    store.interruptRecord(second.id, "failed");

    store.discardConversation("a");

    expect(store.list()).toEqual([expect.objectContaining({ id: second.id, input: expect.objectContaining({ conversationId: "b" }) })]);
  });
});
