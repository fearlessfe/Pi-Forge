import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentRunStore } from "./subagent-run-store.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runs-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SubagentRunStore", () => {
  it("persists lifecycle state and an independent usage ledger", () => {
    const directory = temporaryDirectory();
    const store = new SubagentRunStore(directory);
    const running = store.create({
      parentRunId: "parent-run",
      parentConversationId: "parent-conversation",
      toolCallId: "call-subagent",
      role: "reviewer",
      task: "Review the change",
      cwd: "/workspace",
      sessionId: "child-session",
    });
    store.update(running.id, {
      status: "completed",
      completedAt: "2026-07-27T01:02:03.000Z",
      usage: {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        totalTokens: 170,
        requestCount: 2,
        cost: 0.042,
      },
    });

    const restored = new SubagentRunStore(directory);
    expect(restored.findByToolCall("call-subagent", "parent-conversation")).toMatchObject({
      id: running.id,
      status: "completed",
      sessionId: "child-session",
      usage: { requestCount: 2, totalTokens: 170, cost: 0.042 },
    });
    expect(fs.statSync(path.join(directory, "index.json")).mode & 0o777).toBe(0o600);
  });

  it("records stopped and failed runs without losing completed runs", () => {
    const directory = temporaryDirectory();
    const store = new SubagentRunStore(directory);
    const first = store.create({ toolCallId: "first", role: "one", task: "one", cwd: "/workspace", sessionId: "one" });
    const second = store.create({ toolCallId: "second", role: "two", task: "two", cwd: "/workspace", sessionId: "two" });
    store.update(first.id, { status: "stopped", completedAt: new Date().toISOString(), error: "aborted" });
    store.update(second.id, { status: "error", completedAt: new Date().toISOString(), error: "provider failed" });

    expect(new SubagentRunStore(directory).list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: "first", status: "stopped", error: "aborted" }),
      expect.objectContaining({ toolCallId: "second", status: "error", error: "provider failed" }),
    ]));
  });

  it("marks a run interrupted by Runtime exit as stopped on reload", () => {
    const directory = temporaryDirectory();
    const running = new SubagentRunStore(directory).create({
      toolCallId: "interrupted",
      role: "reviewer",
      task: "Review",
      cwd: "/workspace",
      sessionId: "child",
    });

    expect(new SubagentRunStore(directory).list()).toEqual([
      expect.objectContaining({ id: running.id, status: "stopped", completedAt: expect.any(String), error: expect.stringContaining("Runtime exited") }),
    ]);
  });

  it("ignores malformed indexes and invalid records", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "index.json"), "{broken", "utf8");
    expect(new SubagentRunStore(directory).list()).toEqual([]);

    const now = new Date().toISOString();
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({ version: 1, runs: [
      null,
      { id: "invalid", status: "unknown" },
      { id: "valid", toolCallId: "call", role: "reviewer", task: "review", cwd: "/workspace", sessionId: "session", status: "running", startedAt: now, updatedAt: now },
    ] }), "utf8");
    expect(new SubagentRunStore(directory).list()).toEqual([expect.objectContaining({ id: "valid", status: "stopped" })]);
  });
});
