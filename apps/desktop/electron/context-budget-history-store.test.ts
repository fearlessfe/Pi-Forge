import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextBudgetHistoryStore } from "./context-budget-history-store.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-budget-history-"));
}

describe("ContextBudgetHistoryStore", () => {
  it("persists metadata-only snapshots and derives estimate drift", () => {
    const directory = temporaryDirectory();
    const cwd = path.join(directory, "workspace");
    const first = new ContextBudgetHistoryStore(directory);
    const snapshot = first.record({
      cwd,
      conversationId: "conversation-1",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
      estimatorId: "gpt-tokenizer-o200k-v1",
      estimateBasis: "baseline",
      estimatedResourceTokens: 2_000,
      actualInputTokens: 7_000,
      actualContextTokens: 8_000,
    });

    expect(snapshot).toMatchObject({ deltaTokens: 6_000, estimatedSharePercent: 25 });
    expect(JSON.parse(fs.readFileSync(path.join(directory, "context-budget-history.json"), "utf8"))).not.toHaveProperty("content");
    expect(new ContextBudgetHistoryStore(directory).list(cwd)).toEqual([snapshot]);
  });

  it("marks legacy snapshots as potential estimates so they are not mixed with the default trend", () => {
    const directory = temporaryDirectory();
    const cwd = path.join(directory, "workspace");
    const filePath = path.join(directory, "context-budget-history.json");
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      snapshots: [{
        id: "legacy",
        cwd,
        conversationId: "conversation-1",
        runId: "run-1",
        createdAt: new Date().toISOString(),
        provider: "openai",
        model: "gpt-5",
        estimatorId: "gpt-tokenizer-o200k-v1",
        estimatedResourceTokens: 2_000,
        actualInputTokens: 7_000,
        actualContextTokens: 8_000,
        deltaTokens: 6_000,
        estimatedSharePercent: 25,
      }],
    }));

    expect(new ContextBudgetHistoryStore(directory).list(cwd)[0]?.estimateBasis).toBe("potential");
  });

  it("ignores malformed persisted records", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "context-budget-history.json"), JSON.stringify({ version: 1, snapshots: [{ cwd: "relative", content: "secret" }] }));
    expect(new ContextBudgetHistoryStore(directory).list(directory)).toEqual([]);
  });
});
