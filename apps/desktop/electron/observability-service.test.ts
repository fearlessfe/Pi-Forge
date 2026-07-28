import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import type { ResponseUsage } from "../src/contracts.js";
import { ObservabilityService } from "./observability-service.js";
import { ObservabilityStore } from "./observability-store.js";
import type { TraceSpanRecord } from "./trace-model.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("ObservabilityService", () => {
  it("turns runtime events into a local, queryable trace without external configuration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observability-"));
    directories.push(root);
    const service = new ObservabilityService(new ObservabilityStore(root), root);
    const usage: ResponseUsage = {
      provider: "openai",
      model: "gpt-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      requestCount: 1,
      cost: 0.001,
    };

    service.record({ type: "run.started", runId: "run", conversationId: "conversation", provider: "openai", model: "gpt-5", cwd: "/workspace" }, "hello");
    service.record({ type: "agent.event", runId: "run", event: { sequence: 1, timestamp: Date.now(), eventType: "turn_start", payload: { type: "turn_start" } } });
    service.record({ type: "agent.event", runId: "run", event: { sequence: 2, timestamp: Date.now(), eventType: "message_start", payload: { type: "message_start", message: { role: "assistant" } } } });
    service.record({ type: "message.delta", runId: "run", text: "world" });
    service.record({ type: "response.usage", runId: "run", usage });
    service.record({ type: "agent.event", runId: "run", event: { sequence: 3, timestamp: Date.now(), eventType: "turn_end", payload: { type: "turn_end" } } });
    service.record({ type: "run.completed", runId: "run" });
    await service.shutdown();

    const status = service.status();
    expect(status.localTracePath).toBeTruthy();
    const spans = fs.readFileSync(status.localTracePath!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as TraceSpanRecord);
    expect(spans.map((span) => span.name)).toEqual(["gen_ai.chat", "agent.turn", "agent.run"]);
    expect(spans.find((span) => span.name === "agent.run")?.attributes).toMatchObject({
      "agent.run.id": "run",
      "agent.conversation.id": "conversation",
      "agent.input.size": 5,
    });
    expect(spans.find((span) => span.name === "gen_ai.chat")?.attributes).toMatchObject({
      "gen_ai.usage.total_tokens": 15,
      "gen_ai.output.size": 5,
    });
  });
});
