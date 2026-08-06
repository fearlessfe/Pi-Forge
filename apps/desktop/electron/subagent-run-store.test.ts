import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidSubagentRunTransitionError, SubagentRunStore, UnsupportedSubagentRunStoreVersionError } from "./subagent-run-store.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runs-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createRun(store: SubagentRunStore, toolCallId: string) {
  return store.create({
    parentRunId: "parent-run",
    parentConversationId: "parent-conversation",
    toolCallId,
    role: "reviewer",
    task: `Review ${toolCallId}`,
    cwd: "/workspace",
    sessionId: `session-${toolCallId}`,
  });
}

const usage = {
  provider: "openai",
  model: "gpt-5",
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 20,
  cacheWriteTokens: 0,
  totalTokens: 170,
  requestCount: 2,
  cost: 0.042,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SubagentRunStore", () => {
  it("atomically reuses the record for the same parent run and tool call", () => {
    const store = new SubagentRunStore(temporaryDirectory());
    const first = createRun(store, "replayed");
    const duplicate = store.createOrGet({
      parentRunId: "parent-run",
      parentConversationId: "parent-conversation",
      toolCallId: "replayed",
      role: "different replay payload",
      task: "must not replace durable input",
      cwd: "/workspace",
      sessionId: "replacement-session",
    });

    expect(duplicate).toEqual(first);
    expect(store.list()).toHaveLength(1);
  });

  it("persists queued, claimed, and completed lifecycle data atomically", () => {
    const directory = temporaryDirectory();
    const store = new SubagentRunStore(directory);
    const queued = createRun(store, "call-subagent");
    expect(queued).toMatchObject({ status: "queued", attempt: 0, queuedAt: queued.startedAt });

    const running = store.claimNext();
    expect(running).toMatchObject({ id: queued.id, status: "running", attempt: 1 });
    store.complete(queued.id, { result: "No issues found.", usage });

    const restored = new SubagentRunStore(directory);
    expect(restored.findByToolCall("call-subagent", "parent-conversation")).toMatchObject({
      id: queued.id,
      status: "completed",
      attempt: 1,
      result: "No issues found.",
      usage: { requestCount: 2, totalTokens: 170, cost: 0.042 },
    });
    expect(fs.statSync(path.join(directory, "index.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "index.json"), "utf8"))).toMatchObject({ version: 2 });
  });

  it("keeps the previous durable and in-memory index if an atomic rename fails", () => {
    const directory = temporaryDirectory();
    const store = new SubagentRunStore(directory);
    const first = createRun(store, "first");
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });

    expect(() => createRun(store, "not-persisted")).toThrow("simulated rename failure");
    rename.mockRestore();

    expect(store.list()).toEqual([expect.objectContaining({ id: first.id })]);
    expect(new SubagentRunStore(directory).list()).toEqual([expect.objectContaining({ id: first.id })]);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("supports pause, resume, failure, retry, and stop transitions", () => {
    const store = new SubagentRunStore(temporaryDirectory());
    const queued = createRun(store, "lifecycle");

    expect(store.pause(queued.id)).toMatchObject({ status: "paused", attempt: 0 });
    const resumed = store.resume(queued.id);
    expect(resumed).toMatchObject({ status: "queued", attempt: 0 });
    expect(resumed?.queuedAt.localeCompare(queued.queuedAt)).toBeGreaterThan(0);
    expect(store.claimNext()).toMatchObject({ status: "running", attempt: 1 });
    expect(store.fail(queued.id, "provider failed", usage)).toMatchObject({
      status: "error",
      error: "provider failed",
      completedAt: expect.any(String),
      usage,
    });
    expect(store.retry(queued.id)).toMatchObject({
      status: "queued",
      attempt: 1,
      completedAt: undefined,
      error: undefined,
    });
    expect(store.claimNext()).toMatchObject({ status: "running", attempt: 2 });
    expect(store.stop(queued.id, "cancelled")).toMatchObject({
      status: "stopped",
      attempt: 2,
      error: "cancelled",
      completedAt: expect.any(String),
    });
  });

  it("rejects illegal state transitions without changing persisted state", () => {
    const directory = temporaryDirectory();
    const store = new SubagentRunStore(directory);
    const queued = createRun(store, "illegal");
    store.claimNext();
    store.complete(queued.id, { result: "done" });

    expect(() => store.pause(queued.id)).toThrow(InvalidSubagentRunTransitionError);
    expect(() => store.retry(queued.id)).toThrow(/completed to queued/);
    expect(() => store.update(queued.id, { status: "running" })).toThrow(/completed to running/);
    expect(store.pause("missing")).toBeUndefined();
    expect(new SubagentRunStore(directory).list()).toEqual([
      expect.objectContaining({ id: queued.id, status: "completed", result: "done" }),
    ]);
  });

  it("claims queued runs in FIFO order and puts resumed runs at the back", () => {
    const store = new SubagentRunStore(temporaryDirectory());
    const first = createRun(store, "first");
    const second = createRun(store, "second");
    const third = createRun(store, "third");
    store.pause(second.id);

    expect(store.claimNext()?.id).toBe(first.id);
    expect(store.claimNext()?.id).toBe(third.id);
    expect(store.claimNext()).toBeUndefined();
    store.resume(second.id);
    expect(store.claimNext()?.id).toBe(second.id);
  });

  it("migrates v1 records and requeues a formerly running run", () => {
    const directory = temporaryDirectory();
    const now = "2026-07-27T01:02:03.000Z";
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({ version: 1, runs: [
      {
        id: "running-v1",
        toolCallId: "running",
        role: "reviewer",
        task: "Review",
        cwd: "/workspace",
        sessionId: "running-session",
        status: "running",
        startedAt: now,
        updatedAt: now,
        error: "stale error",
      },
      {
        id: "completed-v1",
        toolCallId: "completed",
        role: "reviewer",
        task: "Review",
        cwd: "/workspace",
        sessionId: "completed-session",
        status: "completed",
        startedAt: now,
        updatedAt: now,
        completedAt: now,
      },
    ] }), "utf8");

    const migrated = new SubagentRunStore(directory);
    expect(migrated.findByToolCall("running")).toMatchObject({
      status: "queued",
      attempt: 1,
      queuedAt: now,
      completedAt: undefined,
      error: undefined,
    });
    expect(migrated.findByToolCall("completed")).toMatchObject({ status: "completed", attempt: 1, queuedAt: now });
    expect(JSON.parse(fs.readFileSync(path.join(directory, "index.json"), "utf8"))).toMatchObject({ version: 2 });
  });

  it("recovers only running v2 records back into the queue after restart", () => {
    const directory = temporaryDirectory();
    const store = new SubagentRunStore(directory);
    const running = createRun(store, "interrupted");
    const paused = createRun(store, "paused");
    store.claimNext((run) => run.id === running.id);
    store.pause(paused.id);

    const restored = new SubagentRunStore(directory);
    expect(restored.findByToolCall("interrupted")).toMatchObject({
      status: "queued",
      attempt: 1,
      completedAt: undefined,
      error: undefined,
    });
    expect(restored.findByToolCall("paused")).toMatchObject({ status: "paused", attempt: 0 });
    expect(restored.claimNext()?.id).toBe(running.id);
    expect(restored.findByToolCall("interrupted")).toMatchObject({ status: "running", attempt: 2 });
  });

  it("ignores malformed indexes and invalid records", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "index.json"), "{broken", "utf8");
    expect(new SubagentRunStore(directory).list()).toEqual([]);

    const now = new Date().toISOString();
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({ version: 2, runs: [
      null,
      { id: "invalid", status: "unknown" },
      {
        id: "valid",
        toolCallId: "call",
        role: "reviewer",
        task: "review",
        cwd: "/workspace",
        sessionId: "session",
        status: "paused",
        attempt: 1,
        queuedAt: now,
        startedAt: now,
        updatedAt: now,
      },
    ] }), "utf8");
    expect(new SubagentRunStore(directory).list()).toEqual([expect.objectContaining({ id: "valid", status: "paused" })]);
  });

  it("fails closed for unknown future store versions", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({ version: 99, runs: [] }), "utf8");
    expect(() => new SubagentRunStore(directory)).toThrow(UnsupportedSubagentRunStoreVersionError);
  });
});
