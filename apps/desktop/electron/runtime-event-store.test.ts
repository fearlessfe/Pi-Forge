import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/contracts.js";
import { RuntimeEventStore } from "./runtime-event-store.js";

const directories: string[] = [];

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-events-"));
  directories.push(value);
  return value;
}

function events(): AgentEvent[] {
  return [
    { type: "run.started", conversationId: "conversation-1", runId: "run-1", provider: "test", model: "model", cwd: "/workspace" },
    { type: "agent.event", runId: "run-1", event: { sequence: 1, timestamp: 1, eventType: "turn_start", payload: {} } },
    { type: "user.message.started", runId: "run-1", message: "Inspect the workspace" },
    { type: "thinking.delta", runId: "run-1", text: "Thinking" },
    { type: "message.delta", runId: "run-1", text: "Done" },
    { type: "tool.started", runId: "run-1", callId: "call-1", name: "read", args: { path: "README.md" } },
    { type: "tool.updated", runId: "run-1", callId: "call-1", name: "read", output: "partial" },
    { type: "tool.completed", runId: "run-1", callId: "call-1", name: "read", output: "complete", isError: false },
    { type: "agent.event", runId: "run-1", event: { sequence: 2, timestamp: 2, eventType: "turn_end", payload: {} } },
    { type: "run.completed", runId: "run-1" },
  ];
}

afterEach(() => {
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("RuntimeEventStore", () => {
  it("persists globally ordered events and queries conversation/run/turn/tool scopes", () => {
    const root = directory();
    let nextId = 0;
    const store = new RuntimeEventStore(root, () => 1_700_000_000_000, () => `event-${++nextId}`);
    const recorded = events().map((event) => store.record(event));

    expect(recorded.map((record) => record.offset)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(recorded.every((record) => record.conversationId === "conversation-1")).toBe(true);
    expect(recorded.slice(1).every((record) => record.turnId === "run-1:turn:1")).toBe(true);
    expect(store.query({ conversationId: "conversation-1", limit: 4 })).toMatchObject({
      events: [{ offset: 1 }, { offset: 2 }, { offset: 3 }, { offset: 4 }],
      nextOffset: 4,
      highWatermark: 10,
      hasMore: true,
    });
    expect(store.query({ runId: "run-1", afterOffset: 4, eventTypes: ["message.delta"] }).events.map((record) => record.offset)).toEqual([5]);
    expect(store.query({ turnId: "run-1:turn:1" }).events).toHaveLength(9);
    expect(store.query({ toolCallId: "call-1" }).events.map((record) => record.event.type))
      .toEqual(["tool.started", "tool.updated", "tool.completed"]);

    const reopened = new RuntimeEventStore(root, () => 1_700_000_001_000, () => "event-11");
    expect(reopened.highWatermark()).toBe(10);
    expect(reopened.record({ type: "runtime.status", status: "running", conversationId: "conversation-1" }).offset).toBe(11);
  });

  it("persists named checkpoints and rejects offsets beyond the durable high watermark", () => {
    const root = directory();
    const store = new RuntimeEventStore(root, () => 1_700_000_000_000, () => "event-1");
    store.record(events()[0]);
    expect(store.saveCheckpoint("renderer:last-seen")).toMatchObject({ name: "renderer:last-seen", offset: 1 });
    expect(store.saveCheckpoint("exporter.otlp", 0)).toMatchObject({ name: "exporter.otlp", offset: 0 });
    expect(() => store.saveCheckpoint("future", 2)).toThrow("offset 无效");
    expect(new RuntimeEventStore(root).listCheckpoints().map((checkpoint) => checkpoint.name))
      .toEqual(["exporter.otlp", "renderer:last-seen"]);
  });

  it("replays durable records into deterministic run, turn, and tool state", () => {
    const store = new RuntimeEventStore(directory(), () => 1_700_000_000_000);
    for (const event of events()) store.record(event);
    const snapshot = store.replay({ conversationId: "conversation-1" });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      afterOffset: 0,
      highWatermark: 10,
      runs: [{
        runId: "run-1",
        conversationId: "conversation-1",
        status: "completed",
        provider: "test",
        model: "model",
        cwd: "/workspace",
        completedOffset: 10,
        turns: [{
          turnId: "run-1:turn:1",
          userMessage: "Inspect the workspace",
          thinkingText: "Thinking",
          assistantText: "Done",
          completedOffset: 9,
          tools: [{ callId: "call-1", name: "read", status: "completed", output: "complete", startedOffset: 6, completedOffset: 8 }],
        }],
      }],
    });
  });

  it("migrates the legacy unversioned JSONL format and preserves offsets", () => {
    const root = directory();
    const legacy = [
      { sequence: 4, timestamp: 1_700_000_000_000, event: events()[0] },
      { sequence: 5, timestamp: 1_700_000_000_001, event: events()[1] },
    ];
    fs.writeFileSync(path.join(root, "events.jsonl"), `${legacy.map((value) => JSON.stringify(value)).join("\n")}\n`);
    const store = new RuntimeEventStore(root);

    expect(store.query().events.map((record) => ({ offset: record.offset, eventId: record.eventId })))
      .toEqual([{ offset: 4, eventId: "migrated-4" }, { offset: 5, eventId: "migrated-5" }]);
    expect(fs.existsSync(path.join(root, "events.jsonl.migrated-v0"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))).toEqual({ schemaVersion: 1, eventFile: "events.v1.jsonl" });
    fs.unlinkSync(path.join(root, "manifest.json"));
    expect(new RuntimeEventStore(root).record(events()[2]).offset).toBe(6);
  });

  it("recovers a torn final append but fails closed for unknown schema versions", () => {
    const root = directory();
    const store = new RuntimeEventStore(root);
    store.record(events()[0]);
    fs.appendFileSync(path.join(root, "events.v1.jsonl"), "{\"schemaVersion\":1");
    expect(new RuntimeEventStore(root).query().events).toHaveLength(1);

    const futureRoot = directory();
    fs.writeFileSync(path.join(futureRoot, "manifest.json"), JSON.stringify({ schemaVersion: 2, eventFile: "events.v2.jsonl" }));
    expect(() => new RuntimeEventStore(futureRoot)).toThrow("不支持的 Runtime 事件存储版本");
  });
});
