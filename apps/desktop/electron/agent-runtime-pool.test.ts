import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ProjectResourceSettings, SaveModelSettings } from "../src/contracts.js";
import { AgentRuntimePool } from "./agent-runtime-pool.js";
import { agentRuntimeProtocolVersion, type ParentToRuntimeMessage } from "./agent-runtime-protocol.js";
import { ConversationProfileStore } from "./conversation-profile-store.js";

class FakeRuntime extends EventEmitter {
  readonly requests: Array<Extract<ParentToRuntimeMessage, { kind: "runtime.request" }>> = [];
  readonly profiles: unknown[] = [];
  connected = true;
  activeRunId?: string;
  conversationId?: string;
  disconnected = false;
  respondToPing = true;

  send(message: ParentToRuntimeMessage, callback?: (error: Error | null) => void): boolean {
    callback?.(null);
    if (message.kind === "runtime.init") {
      queueMicrotask(() => this.emit("message", { kind: "runtime.ready", protocolVersion: agentRuntimeProtocolVersion, pid: 42 }));
      return true;
    }
    if (message.kind === "runtime.ping") {
      if (this.respondToPing) queueMicrotask(() => this.emit("message", { kind: "runtime.pong", id: message.id }));
      return true;
    }
    if (message.kind !== "runtime.request") return true;
    this.requests.push(message);
    if (message.method === "updateConfiguration") this.profiles.push(message.args[0]);
    let result: unknown;
    if (message.method === "send") {
      this.conversationId = message.args[2] as string;
      this.activeRunId = `run-${this.conversationId}`;
      result = this.activeRunId;
    } else if (message.method === "listConversations") result = [];
    else if (message.method === "listConversationPage") result = { items: [], total: 0 };
    else if (message.method === "loadConversation") result = { id: message.args[0], title: "", cwd: "/tmp", createdAt: "", updatedAt: "", tags: [], archived: false, searchText: "", turns: [] };
    else if (message.method === "clearQueue" || message.method === "queueMessage") result = { steering: [], followUp: [] };
    else if (message.method === "listChanges" || message.method === "acceptChanges" || message.method === "revertChanges" || message.method === "listPlanReviews") result = [];
    queueMicrotask(() => {
      this.emit("message", { kind: "runtime.response", id: message.id, result });
      if (message.method === "send" && this.activeRunId && this.conversationId) {
        this.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: this.activeRunId, conversationId: this.conversationId, provider: "test", model: "test", cwd: "/tmp" } });
      }
      if (message.method === "abort" && this.activeRunId) {
        this.emit("message", { kind: "runtime.event", event: { type: "run.stopped", runId: this.activeRunId } });
        this.activeRunId = undefined;
      }
    });
    return true;
  }

  complete(): void {
    if (!this.activeRunId) return;
    this.emit("message", { kind: "runtime.event", event: { type: "run.completed", runId: this.activeRunId } });
    this.activeRunId = undefined;
  }

  kill(): boolean { this.connected = false; return true; }
  disconnect(): void { this.connected = false; this.disconnected = true; }
}

const directories: string[] = [];
const pools: AgentRuntimePool[] = [];

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-pool-"));
  directories.push(value);
  return value;
}

function projectSettings(cwd: string): ProjectResourceSettings {
  return { cwd, selectionMode: "custom", selectedSkills: ["safe-skill"], selectedMcpServers: ["project:safe"], skillOverrides: {}, mcpServerOverrides: {} };
}

function setup(maxParallel = 3, heartbeat = false) {
  const root = directory();
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  const children: FakeRuntime[] = [];
  const events: AgentEvent[] = [];
  const defaults: SaveModelSettings = { provider: "openai", baseUrl: "https://api.example.test", modelId: "default", thinkingLevel: "medium" };
  const pool = new AgentRuntimePool({
    workerPath: path.join(root, "worker.js"), userDataPath: root, agentDir: root, fallbackCwd: cwd, sessionDir: path.join(root, "sessions"),
    settings: { resolve: (input?: SaveModelSettings) => ({ ...(input ?? defaults), apiKey: "secret-not-persisted" }) },
    credentials: { read: vi.fn(), list: vi.fn(async () => []), modify: vi.fn(), delete: vi.fn() } as never,
    mcp: { tools: vi.fn(async () => []), contextInventory: vi.fn(async () => []), callTool: vi.fn(async () => ({ text: "", details: undefined })) },
    browser: { startAnnotation: vi.fn() },
    emit: (event) => events.push(event),
    observe: vi.fn(),
    profiles: new ConversationProfileStore(root),
    resources: { getProjectSettings: projectSettings },
    maxParallel,
    heartbeatIntervalMs: heartbeat ? 5 : 0,
    heartbeatMissLimit: 1,
    startupTimeoutMs: 0,
    forkProcess: (() => { const child = new FakeRuntime(); children.push(child); return child as unknown as ChildProcess; }) as never,
  });
  pools.push(pool);
  return { pool, children, events, cwd };
}

afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("AgentRuntimePool", () => {
  it("runs two conversations concurrently with frozen independent models and resource profiles", async () => {
    const { pool, children, cwd } = setup();
    const a = pool.getProfile("a", cwd);
    const b = pool.getProfile("b", cwd);
    pool.saveProfile({ ...a, modelId: "model-a", selectedSkills: ["safe-skill"], selectedMcpServers: ["project:safe"] });
    pool.saveProfile({ ...b, modelId: "model-b", selectedSkills: [], selectedMcpServers: [] });

    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);

    expect(pool.isRunning("a")).toBe(true);
    expect(pool.isRunning("b")).toBe(true);
    expect(children).toHaveLength(2);
    expect(children[0].profiles.at(-1)).toMatchObject({ modelSettings: { modelId: "model-a" }, selectedSkills: ["safe-skill"] });
    expect(children[1].profiles.at(-1)).toMatchObject({ modelSettings: { modelId: "model-b" }, selectedSkills: [] });
    expect(JSON.stringify(fs.readFileSync(path.join(path.dirname(cwd), "conversation-profiles.json"), "utf8"))).not.toContain("secret-not-persisted");
  });

  it("enforces the parallel limit without overwriting an active conversation", async () => {
    const { pool, cwd } = setup(2);
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    await expect(pool.send("C", cwd, "c")).rejects.toThrow("最多可并行 2 个");
    await expect(pool.send("again", cwd, "a")).rejects.toThrow("该会话已有任务在运行");
  });

  it("routes abort and queue to one conversation and leaves the other worker running", async () => {
    const { pool, children, cwd } = setup();
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    await pool.queueMessage("b", "follow", "followUp");
    await pool.abort("a");

    expect(children[0].requests.some((request) => request.method === "abort")).toBe(true);
    expect(children[0].requests.some((request) => request.method === "queueMessage")).toBe(false);
    expect(children[1].requests.some((request) => request.method === "queueMessage")).toBe(true);
    expect(pool.isRunning("a")).toBe(false);
    expect(pool.isRunning("b")).toBe(true);
  });

  it("routes question, queue clearing, plan review, and reset by conversation", async () => {
    const { pool, children, cwd } = setup();
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    await pool.answerQuestion("a", "question-a", "yes");
    await pool.clearQueue("b");
    await pool.resolvePlanReview("b", { reviewId: "review-b", versionId: "v1", decision: "approved", annotations: [] });
    children[1].complete();
    await pool.reset("b");

    expect(children[0].requests.map((request) => request.method)).toContain("answerQuestion");
    expect(children[0].requests.map((request) => request.method)).not.toContain("clearQueue");
    expect(children[1].requests.map((request) => request.method)).toEqual(expect.arrayContaining(["clearQueue", "resolvePlanReview", "reset"]));
  });

  it("isolates a worker crash and routes its error with the owning conversation", async () => {
    const { pool, children, events, cwd } = setup();
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    children[0].emit("exit", 1, null);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "run.error", conversationId: "a", runId: "run-a" })));
    expect(pool.isRunning("b")).toBe(true);
  });

  it("isolates one worker heartbeat timeout without stopping another conversation", async () => {
    const { pool, children, events, cwd } = setup(3, true);
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    children[0].respondToPing = false;
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "runtime.status", conversationId: "a", status: "unresponsive" })), { timeout: 500 });
    expect(pool.isRunning("b")).toBe(true);
    expect(children[1].disconnected).toBe(false);
  });

  it("loading another conversation does not abort background runs and shutdown closes every worker", async () => {
    const { pool, children, cwd } = setup();
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    await pool.loadConversation("a");
    expect(children.flatMap((child) => child.requests).filter((request) => request.method === "abort")).toHaveLength(0);
    pool.dispose();
    expect(children.every((child) => child.disconnected)).toBe(true);
    expect(pool.isRunning()).toBe(false);
  });

  it("aborting deletion releases only that conversation and removes its persisted profile", async () => {
    const { pool, children, cwd } = setup();
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    await pool.deleteConversation("a");

    expect(pool.isRunning("a")).toBe(false);
    expect(pool.isRunning("b")).toBe(true);
    expect(children[0].disconnected).toBe(true);
    const stored = JSON.parse(fs.readFileSync(path.join(path.dirname(cwd), "conversation-profiles.json"), "utf8")) as { profiles: Record<string, unknown> };
    expect(stored.profiles.a).toBeUndefined();
    expect(stored.profiles.b).toBeDefined();
  });

  it("reuses a released slot after an out-of-order terminal event", async () => {
    const { pool, children, cwd } = setup(2);
    await Promise.all([pool.send("A", cwd, "a"), pool.send("B", cwd, "b")]);
    children[0].complete();
    await pool.send("C", cwd, "c");
    expect(pool.isRunning("b")).toBe(true);
    expect(pool.isRunning("c")).toBe(true);
  });
});
