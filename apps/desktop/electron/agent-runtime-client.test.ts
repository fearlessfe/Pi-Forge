import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { runtimeCapabilities, runtimeProtocolVersion } from "@pi-forge/runtime-contracts";
import type { AgentEvent } from "../src/contracts.js";
import { AgentRuntimeClient } from "./agent-runtime-client.js";
import { agentRuntimeProtocolVersion, type ParentToRuntimeMessage, type RuntimeToParentMessage } from "./agent-runtime-protocol.js";
import type { BrowserDebugPort } from "./browser-service.js";
import { RuntimeRecoveryStore } from "./runtime-recovery-store.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, fork: vi.fn() };
});

const forkMock = vi.mocked(fork);

class FakeChildProcess extends EventEmitter {
  readonly sent: ParentToRuntimeMessage[] = [];
  readonly stdout = null;
  readonly stderr = null;
  connected = true;

  send(message: ParentToRuntimeMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  kill(): boolean {
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (eventName === "message" && args[0] && typeof args[0] === "object") {
      const message = args[0] as Record<string, unknown>;
      if (typeof message.kind === "string" && message.kind.startsWith("runtime.")) {
        message.protocolVersion ??= runtimeProtocolVersion;
        if (message.kind === "runtime.ready") message.capabilities ??= [...runtimeCapabilities];
        if (message.kind === "runtime.response" && message.error && typeof message.error === "object") {
          (message.error as Record<string, unknown>).code ??= "internal_error";
        }
      }
    }
    return super.emit(eventName, ...args);
  }

  emitRawMessage(message: unknown): boolean {
    return super.emit("message", message);
  }
}

const temporaryDirectories: string[] = [];
const clients: AgentRuntimeClient[] = [];
let children: FakeChildProcess[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-client-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function lastChild(): FakeChildProcess {
  const child = children.at(-1);
  if (!child) throw new Error("expected the runtime worker to be forked");
  return child;
}

function emitReady(child: FakeChildProcess, protocolVersion: number = agentRuntimeProtocolVersion): void {
  child.emit("message", { kind: "runtime.ready", protocolVersion, pid: 4242 } as RuntimeToParentMessage);
}

function lastRequest(child: FakeChildProcess): Extract<ParentToRuntimeMessage, { kind: "runtime.request" }> {
  const request = child.sent.filter((message) => message.kind === "runtime.request").at(-1);
  if (!request || request.kind !== "runtime.request") throw new Error("expected a runtime request");
  return request;
}

type ClientOptions = ConstructorParameters<typeof AgentRuntimeClient>[0];

function baseOptions(events: AgentEvent[]): ClientOptions {
  return {
    workerPath: path.join(temporaryDirectory(), "agent-runtime-worker.js"),
    userDataPath: temporaryDirectory(),
    agentDir: temporaryDirectory(),
    fallbackCwd: temporaryDirectory(),
    sessionDir: temporaryDirectory(),
    settings: {
      resolve: () => ({ provider: "openai", baseUrl: "https://example.com", modelId: "gpt-test", thinkingLevel: "off" }),
    },
    credentials: {
      read: vi.fn(async () => ({ type: "api_key", key: "test-key" })),
      list: vi.fn(async () => []),
      modify: vi.fn(async (_provider: string, update: (current: unknown) => Promise<unknown>) => update(undefined)),
      delete: vi.fn(async () => undefined),
    } as unknown as CredentialStore,
    mcp: { tools: vi.fn(async () => []), contextInventory: vi.fn(async () => []), callTool: vi.fn(async () => ({ text: "", details: undefined })) },
    browser: { startAnnotation: vi.fn() } as unknown as BrowserDebugPort,
    emit: (event) => events.push(event),
    heartbeatIntervalMs: 0,
    startupTimeoutMs: 0,
  };
}

function createClient(events: AgentEvent[] = [], overrides?: Partial<ClientOptions>): AgentRuntimeClient {
  const client = new AgentRuntimeClient({ ...baseOptions(events), ...overrides });
  clients.push(client);
  return client;
}

beforeEach(() => {
  children = [];
  forkMock.mockReset();
  forkMock.mockImplementation(() => {
    const child = new FakeChildProcess();
    children.push(child);
    return child as unknown as ChildProcess;
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.dispose();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("AgentRuntimeClient", () => {
  it("rejects ready when the worker protocol version mismatches", async () => {
    const events: AgentEvent[] = [];
    const client = createClient(events);
    const child = lastChild();
    const catalog = client.getModelCatalog();
    emitReady(child, agentRuntimeProtocolVersion + 1);

    await expect(catalog).rejects.toThrow("协议版本不兼容");
    expect(child.connected).toBe(false);
    expect(events).toContainEqual({ type: "runtime.status", status: "unresponsive" });
  });

  it("rejects a worker that does not negotiate every required capability", async () => {
    const events: AgentEvent[] = [];
    const client = createClient(events);
    const child = lastChild();
    const catalog = client.getModelCatalog();
    child.emitRawMessage({
      kind: "runtime.ready",
      protocolVersion: runtimeProtocolVersion,
      pid: 4242,
      capabilities: ["runtime.rpc", "runtime.events"],
    });

    await expect(catalog).rejects.toThrow("缺少必需能力");
    expect(child.connected).toBe(false);
    expect(events).toContainEqual({ type: "runtime.status", status: "unresponsive" });
  });

  it("fails closed when the worker sends a malformed response", async () => {
    const events: AgentEvent[] = [];
    const client = createClient(events);
    const child = lastChild();
    emitReady(child);
    const catalog = client.getModelCatalog();
    const rejected = catalog.catch((error: unknown) => error);
    await vi.waitFor(() => expect(child.sent.some((message) => message.kind === "runtime.request")).toBe(true));

    child.emitRawMessage({
      kind: "runtime.response",
      protocolVersion: runtimeProtocolVersion,
      id: lastRequest(child).id,
      error: { message: "missing error code" },
    });

    await expect(rejected).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("畸形") }));
    expect(child.connected).toBe(false);
    expect(events).toContainEqual({ type: "runtime.status", status: "unresponsive" });
  });

  it("stops a worker that does not complete startup before the deadline", async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const client = createClient(events, { startupTimeoutMs: 100 });
    const child = lastChild();
    const catalog = client.getModelCatalog();
    const rejected = catalog.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);

    await expect(rejected).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("启动超时") }));
    expect(child.connected).toBe(false);
    expect(events).toContainEqual({ type: "runtime.status", status: "unresponsive" });
  });

  it("rejects pending requests when the child exits", async () => {
    const client = createClient();
    const child = lastChild();
    emitReady(child);

    const pending = client.getModelCatalog();
    await vi.waitFor(() => {
      expect(child.sent.some((message) => message.kind === "runtime.request")).toBe(true);
    });
    child.emit("exit", 1, null);

    await expect(pending).rejects.toThrow("Agent Runtime exited (1).");
  });

  it("increases the restart backoff exponentially until it plateaus", () => {
    vi.useFakeTimers();
    createClient();

    for (const delay of [250, 500, 1000, 2000, 4000, 4000]) {
      const forksBefore = forkMock.mock.calls.length;
      lastChild().emit("exit", 1, null);
      vi.advanceTimersByTime(delay - 1);
      expect(forkMock.mock.calls.length).toBe(forksBefore);
      vi.advanceTimersByTime(1);
      expect(forkMock.mock.calls.length).toBe(forksBefore + 1);
      // Age the crash out of the breaker window so this test stays below the threshold.
      vi.advanceTimersByTime(60_000);
    }
  });

  it("trips the circuit breaker after three crashes within a minute", async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const client = createClient(events);

    for (const delay of [250, 500]) {
      lastChild().emit("exit", 1, null);
      vi.advanceTimersByTime(delay);
    }
    expect(forkMock.mock.calls.length).toBe(3);

    lastChild().emit("exit", 1, null);
    vi.advanceTimersByTime(60_000);

    expect(forkMock.mock.calls.length).toBe(3);
    expect(events).toContainEqual({ type: "runtime.status", status: "crash-looping" });
    await expect(client.getModelCatalog()).rejects.toThrow("已停止自动重启");
  });

  it("resets the breaker and forks a fresh worker on manual retry", async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const client = createClient(events);

    for (const delay of [250, 500]) {
      lastChild().emit("exit", 1, null);
      vi.advanceTimersByTime(delay);
    }
    lastChild().emit("exit", 1, null);
    expect(events).toContainEqual({ type: "runtime.status", status: "crash-looping" });

    const retry = client.retryAfterCrashLoop();
    emitReady(lastChild());
    await retry;

    expect(forkMock.mock.calls.length).toBe(4);
    expect(events).toContainEqual({ type: "runtime.status", status: "running" });

    // The crash counter was reset, so a single new crash restarts normally.
    const forksBefore = forkMock.mock.calls.length;
    lastChild().emit("exit", 1, null);
    vi.advanceTimersByTime(250);
    expect(forkMock.mock.calls.length).toBe(forksBefore + 1);
    expect(events.filter((event) => event.type === "runtime.status" && event.status === "crash-looping")).toHaveLength(1);
  });

  it("routes host requests to the injected handlers and sends the response back", async () => {
    createClient();
    const child = lastChild();
    emitReady(child);

    child.emit("message", { kind: "host.request", id: "host-1", method: "credential.read", args: ["openai"] });

    await vi.waitFor(() => {
      expect(child.sent.some((message) => message.kind === "host.response")).toBe(true);
    });
    expect(child.sent.find((message) => message.kind === "host.response")).toMatchObject({
      id: "host-1",
      result: { type: "api_key", key: "test-key" },
    });
  });

  it("resolves requests with worker responses and rejects on error results", async () => {
    const client = createClient();
    const child = lastChild();
    emitReady(child);

    const catalog = client.getModelCatalog();
    await vi.waitFor(() => {
      expect(child.sent.some((message) => message.kind === "runtime.request")).toBe(true);
    });
    child.emit("message", { kind: "runtime.response", id: lastRequest(child).id, result: [{ id: "openai" }] });
    await expect(catalog).resolves.toEqual([{ id: "openai" }]);

    const failing = client.listConversations();
    await vi.waitFor(() => {
      expect(child.sent.filter((message) => message.kind === "runtime.request")).toHaveLength(2);
    });
    child.emit("message", { kind: "runtime.response", id: lastRequest(child).id, error: { message: "boom", stack: "trace" } });
    await expect(failing).rejects.toThrow("boom");
  });

  it("times out bounded control requests and ignores late responses", async () => {
    vi.useFakeTimers();
    const client = createClient([], { requestTimeoutMs: { getModelCatalog: 100 } });
    const child = lastChild();
    emitReady(child);

    const catalog = client.getModelCatalog();
    const rejected = catalog.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    await expect(rejected).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("请求超时（getModelCatalog，100ms）") }));
    const request = lastRequest(child);
    child.emit("message", { kind: "runtime.response", id: request.id, result: [{ id: "late" }] });

    const next = client.listConversations();
    await vi.advanceTimersByTimeAsync(0);
    child.emit("message", { kind: "runtime.response", id: lastRequest(child).id, result: [] });
    await expect(next).resolves.toEqual([]);
  });

  it("marks a live worker unresponsive after consecutive missed heartbeats", async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const client = createClient(events, { heartbeatIntervalMs: 100, heartbeatMissLimit: 3 });
    const child = lastChild();
    emitReady(child);
    const pending = client.getModelCatalog();
    const rejected = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);

    await expect(rejected).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("心跳连续超时") }));
    expect(child.sent.some((message) => message.kind === "runtime.ping")).toBe(true);
    expect(child.connected).toBe(false);
    expect(events).toContainEqual({ type: "runtime.status", status: "unresponsive" });
    await expect(client.listConversations()).rejects.toThrow("无响应");
  });

  it("interrupts and exposes recovery for an active run after heartbeat loss", async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const client = createClient(events, { heartbeatIntervalMs: 100, heartbeatMissLimit: 3 });
    const child = lastChild();
    emitReady(child);

    const sending = client.send("long task", "/tmp/workspace", "conversation-1");
    await vi.advanceTimersByTimeAsync(0);
    const request = lastRequest(child);
    child.emit("message", { kind: "runtime.response", id: request.id, result: "run-heartbeat" });
    await expect(sending).resolves.toBe("run-heartbeat");

    await vi.advanceTimersByTimeAsync(300);

    expect(client.isRunning()).toBe(false);
    expect(events).toContainEqual({
      type: "run.error",
      runId: "run-heartbeat",
      message: expect.stringContaining("心跳连续超时"),
    });
    expect(events).toContainEqual({ type: "runtime.status", status: "unresponsive" });
    expect(client.listRecoveries()).toEqual([
      expect.objectContaining({ runId: "run-heartbeat", status: "interrupted" }),
    ]);
  });

  it("stops the worker when send acknowledgement times out to prevent a late task", async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const client = createClient(events, { requestTimeoutMs: { send: 100 } });
    const child = lastChild();
    emitReady(child);

    const sending = client.send("make a change", "/tmp", "c-1");
    const rejected = sending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);

    await expect(rejected).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("请求超时（send，100ms）") }));
    expect(child.connected).toBe(false);
    expect(events).toContainEqual({ type: "runtime.status", status: "unresponsive" });
    expect(client.listRecoveries()).toEqual([expect.objectContaining({ status: "interrupted", input: expect.objectContaining({ prompt: "make a change" }) })]);
  });

  it("accepts matching heartbeat pongs and resets the miss counter", async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    createClient(events, { heartbeatIntervalMs: 100, heartbeatMissLimit: 3 });
    const child = lastChild();
    emitReady(child);

    await vi.advanceTimersByTimeAsync(100);
    const firstPing = child.sent.find((message) => message.kind === "runtime.ping");
    expect(firstPing?.kind).toBe("runtime.ping");
    if (firstPing?.kind === "runtime.ping") child.emit("message", { kind: "runtime.pong", id: firstPing.id });
    await vi.advanceTimersByTimeAsync(200);

    expect(events).not.toContainEqual({ type: "runtime.status", status: "unresponsive" });
    expect(child.connected).toBe(true);
  });

  it("sends prompts, tracks the active run, and records an interrupted recovery on exit", async () => {
    const events: AgentEvent[] = [];
    const client = createClient(events);
    const child = lastChild();
    emitReady(child);

    const sending = client.send("hello", "/tmp/workspace", "conversation-1");
    await vi.waitFor(() => {
      expect(child.sent.some((message) => message.kind === "runtime.request")).toBe(true);
    });
    const request = lastRequest(child);
    expect(request.method).toBe("send");
    expect(request.args).toEqual(["hello", "/tmp/workspace", "conversation-1"]);
    child.emit("message", { kind: "runtime.response", id: request.id, result: "run-1" });
    await expect(sending).resolves.toBe("run-1");
    expect(client.isRunning()).toBe(true);

    child.emit("exit", 2, null);

    expect(events).toContainEqual({ type: "run.error", runId: "run-1", message: expect.stringContaining("异常退出") });
    expect(client.listRecoveries()).toEqual([expect.objectContaining({ runId: "run-1", status: "interrupted" })]);
    expect(client.isRunning()).toBe(false);
  });

  it("forwards runtime events and updates the active run state", () => {
    const events: AgentEvent[] = [];
    const client = createClient(events);
    const child = lastChild();
    emitReady(child);
    expect(client.isRunning()).toBe(false);

    child.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: "run-1", conversationId: "c-1", provider: "openai", model: "gpt-test", cwd: "/tmp" } });
    expect(client.isRunning()).toBe(true);
    child.emit("message", { kind: "runtime.event", event: { type: "run.completed", runId: "run-1" } });
    expect(client.isRunning()).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
  });

  it("does not let a stale terminal event clear a newer active run", () => {
    const events: AgentEvent[] = [];
    const client = createClient(events);
    const child = lastChild();
    emitReady(child);
    child.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: "run-old", conversationId: "c-1", provider: "openai", model: "gpt-test", cwd: "/tmp" } });
    child.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: "run-new", conversationId: "c-1", provider: "openai", model: "gpt-test", cwd: "/tmp" } });

    child.emit("message", { kind: "runtime.event", event: { type: "run.completed", runId: "run-old" } });

    expect(client.isRunning()).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "run.completed", runId: "run-old" }));
    child.emit("message", { kind: "runtime.event", event: { type: "run.completed", runId: "run-new" } });
    expect(client.isRunning()).toBe(false);
  });

  it("does not resurrect a run that finishes before the send response is handled", async () => {
    const client = createClient();
    const child = lastChild();
    emitReady(child);
    const sending = client.send("fast", "/tmp", "c-1");
    await vi.waitFor(() => expect(lastRequest(child).method).toBe("send"));
    const request = lastRequest(child);
    child.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: "run-fast", conversationId: "c-1", provider: "openai", model: "gpt-test", cwd: "/tmp" } });
    child.emit("message", { kind: "runtime.event", event: { type: "run.completed", runId: "run-fast" } });
    child.emit("message", { kind: "runtime.response", id: request.id, result: "run-fast" });

    await expect(sending).resolves.toBe("run-fast");
    expect(client.isRunning()).toBe(false);
    expect(client.listRecoveries()).toEqual([]);
  });

  it("stops a dedicated worker when it starts a mismatched conversation", () => {
    const events: AgentEvent[] = [];
    const client = createClient(events, { expectedConversationId: "expected" });
    const child = lastChild();
    emitReady(child);

    child.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: "run-wrong", conversationId: "wrong", provider: "openai", model: "gpt-test", cwd: "/tmp" } });

    expect(client.isRunning()).toBe(false);
    expect(child.connected).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "run.error", conversationId: "expected", runId: "run-wrong" }));
  });

  it("does not corrupt another worker's recovery when an idle worker times out", async () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const recovery = new RuntimeRecoveryStore(directory);
    const active = recovery.begin({ prompt: "active elsewhere", conversationId: "other" });
    recovery.attachRun(active.id, "run-other");
    createClient([], { recoveryStore: recovery, heartbeatIntervalMs: 100, heartbeatMissLimit: 1 });
    const child = lastChild();
    emitReady(child);

    await vi.advanceTimersByTimeAsync(200);

    expect(recovery.get(active.id)).toMatchObject({ status: "running", runId: "run-other" });
    expect(recovery.list()).toEqual([]);
  });

  it("tracks when in-memory conversation history must be reloaded", async () => {
    const client = createClient();
    const first = lastChild();
    emitReady(first);
    expect(client.needsHistoryReload()).toBe(true);
    const loading = client.loadConversation("c-1");
    await vi.waitFor(() => expect(lastRequest(first).method).toBe("loadConversation"));
    const request = lastRequest(first);
    first.emit("message", { kind: "runtime.response", id: request.id, result: { id: "c-1", title: "", cwd: "/tmp", createdAt: "", updatedAt: "", tags: [], archived: false, searchText: "", turns: [] } });
    await loading;
    expect(client.needsHistoryReload()).toBe(false);

    const restarting = client.restart();
    expect(client.needsHistoryReload()).toBe(true);
    emitReady(lastChild());
    await restarting;
  });

  it("rejects new requests while the worker is down", async () => {
    const client = createClient();
    const child = lastChild();
    emitReady(child);
    child.emit("exit", 1, null);

    await expect(client.getModelCatalog()).rejects.toThrow("当前不可用");
  });

  it("rejects pending requests and forks a new worker on restart", async () => {
    const client = createClient();
    const first = lastChild();
    emitReady(first);
    const pending = client.getModelCatalog();
    await vi.waitFor(() => {
      expect(first.sent.some((message) => message.kind === "runtime.request")).toBe(true);
    });

    const restarting = client.restart();
    await expect(pending).rejects.toThrow("已重新启动");
    expect(forkMock.mock.calls.length).toBe(2);
    emitReady(lastChild());
    await restarting;
  });

  it("ignores late ready messages and events from a previous worker after restart", async () => {
    const events: AgentEvent[] = [];
    const client = createClient(events);
    const first = lastChild();
    emitReady(first);

    let restarted = false;
    const restarting = client.restart().then(() => {
      restarted = true;
    });
    const second = lastChild();
    expect(second).not.toBe(first);

    emitReady(first);
    first.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: "stale-run", conversationId: "c-1", provider: "openai", model: "gpt-test", cwd: "/tmp" } });
    await Promise.resolve();

    expect(restarted).toBe(false);
    expect(client.isRunning()).toBe(false);
    expect(events).toEqual([]);

    emitReady(second);
    await restarting;
    expect(restarted).toBe(true);
  });

  it("aborts in-flight host requests on host.cancel", async () => {
    let observedSignal: AbortSignal | undefined;
    const client = createClient([], {
      mcp: {
        tools: vi.fn(async () => []),
        contextInventory: vi.fn(async () => []),
        callTool: vi.fn((_descriptor: unknown, _args: Record<string, unknown>, signal?: AbortSignal) => {
          observedSignal = signal;
          return new Promise<{ text: string; details: unknown }>(() => undefined);
        }),
      },
    });
    const child = lastChild();
    emitReady(child);

    child.emit("message", { kind: "host.request", id: "host-9", method: "mcp.callTool", args: [{ serverKey: "server", name: "tool" }, {}] });
    await vi.waitFor(() => {
      expect(observedSignal).toBeDefined();
    });
    child.emit("message", { kind: "host.cancel", id: "host-9" });

    expect(observedSignal?.aborted).toBe(true);
    expect(client.isRunning()).toBe(false);
  });

  it("intersects MCP tools with the frozen conversation selection and revalidates calls", async () => {
    const callTool = vi.fn(async () => ({ text: "ok", details: undefined }));
    const allowed = { serverKey: "project:allowed", name: "mcp__allowed__read", remoteName: "read", description: "read", inputSchema: { type: "object" } };
    const blocked = { serverKey: "user:blocked", name: "mcp__blocked__read", remoteName: "read", description: "read", inputSchema: { type: "object" } };
    const tools = vi.fn(async () => [allowed, blocked]);
    createClient([], {
      getActiveProfile: () => ({
        cwd: "/trusted/project",
        modelSettings: { provider: "openai", baseUrl: "https://example.com", modelId: "gpt-test", thinkingLevel: "off" },
        resourceSelectionMode: "custom",
        selectedSkills: ["safe"],
        selectedMcpServers: ["project:allowed"],
      }),
      mcp: {
        tools,
        contextInventory: vi.fn(async () => []),
        callTool,
      },
    });
    const child = lastChild();
    emitReady(child);

    child.emit("message", { kind: "host.request", id: "tools", method: "mcp.tools", args: ["/trusted/project"] });
    await vi.waitFor(() => expect(child.sent).toContainEqual(expect.objectContaining({ kind: "host.response", id: "tools", result: [allowed] })));
    expect(tools).toHaveBeenCalledWith("/trusted/project", ["project:allowed"]);

    child.emit("message", { kind: "host.request", id: "blocked", method: "mcp.callTool", args: [blocked, {}] });
    await vi.waitFor(() => expect(child.sent).toContainEqual(expect.objectContaining({ kind: "host.response", id: "blocked", error: expect.objectContaining({ message: expect.stringContaining("未授权") }) })));
    expect(callTool).not.toHaveBeenCalled();

    child.emit("message", { kind: "host.request", id: "allowed", method: "mcp.callTool", args: [allowed, {}] });
    await vi.waitFor(() => expect(child.sent).toContainEqual(expect.objectContaining({ kind: "host.response", id: "allowed", result: { text: "ok" } })));
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("returns host handler errors back to the worker", async () => {
    createClient([], {
      credentials: {
        read: vi.fn(async () => {
          throw new Error("credential missing");
        }),
      } as unknown as CredentialStore,
    });
    const child = lastChild();
    emitReady(child);

    child.emit("message", { kind: "host.request", id: "host-2", method: "credential.read", args: ["openai"] });

    await vi.waitFor(() => {
      expect(child.sent.some((message) => message.kind === "host.response")).toBe(true);
    });
    expect(child.sent.find((message) => message.kind === "host.response")).toMatchObject({
      id: "host-2",
      error: { message: "credential missing" },
    });
  });

  it("routes every host method to its injected handler", async () => {
    const browser = { startAnnotation: vi.fn(async () => ({ success: true })) };
    const mcp = { tools: vi.fn(async () => [{ name: "tool" }]), contextInventory: vi.fn(async () => []), callTool: vi.fn(async () => ({ text: "", details: undefined })) };
    createClient([], { browser: browser as unknown as BrowserDebugPort, mcp: mcp as unknown as ClientOptions["mcp"] });
    const child = lastChild();
    emitReady(child);

    const hostRequests: Array<[string, string, unknown[]]> = [
      ["host-list", "credential.list", []],
      ["host-write", "credential.write", ["openai", { type: "api_key", key: "k" }]],
      ["host-delete", "credential.delete", ["openai"]],
      ["host-tools", "mcp.tools", []],
      ["host-context", "mcp.contextInventory", []],
      ["host-annotation", "browser.startAnnotation", []],
    ];
    for (const [id, method, args] of hostRequests) {
      child.emit("message", { kind: "host.request", id, method, args });
    }
    await vi.waitFor(() => {
      expect(child.sent.filter((message) => message.kind === "host.response")).toHaveLength(hostRequests.length);
    });
    const responses = child.sent.filter((message) => message.kind === "host.response");
    expect(responses.every((message) => !("error" in message && message.error))).toBe(true);
    expect(mcp.tools).toHaveBeenCalledOnce();
    expect(mcp.contextInventory).toHaveBeenCalledOnce();
    expect(browser.startAnnotation).toHaveBeenCalledOnce();
  });

  it("delegates simple method calls to the worker", async () => {
    const client = createClient();
    const child = lastChild();
    emitReady(child);

    const settings = { provider: "openai", baseUrl: "https://example.com", modelId: "gpt-test", thinkingLevel: "off" as const };
    const cases: Array<[() => Promise<unknown>, unknown]> = [
      [() => client.discoverModels(settings), []],
      [() => client.executeExtensionCommand("/review", "/tmp", "c-1"), true],
      [() => client.loadConversation("c-1"), { id: "c-1" }],
      [() => client.forkConversation("c-1", "entry-1"), { id: "c-2" }],
      [() => client.exportConversation("c-1", "markdown"), { filename: "c-1.md" }],
      [() => client.setConversationArchived("c-1", true), undefined],
      [() => client.setConversationTags("c-1", ["tag"]), undefined],
      [() => client.renameConversation("c-1", "title"), undefined],
      [() => client.deleteConversation("c-1"), undefined],
      [() => client.abort(), undefined],
      [() => client.queueMessage("later", "steer"), { steering: ["later"], followUp: [] }],
      [() => client.clearQueue(), { steering: [], followUp: [] }],
      [() => client.listChanges("run-1"), []],
      [() => client.changePath("change-1"), "/tmp/file"],
      [() => client.acceptChanges(["change-1"]), []],
      [() => client.revertChanges(["change-1"]), []],
      [() => client.getPermissionRuntime(), { mode: "balanced" }],
      [() => client.getResourceInventory("/tmp"), { cwd: "/tmp" }],
      [() => client.getContextBudget("/tmp"), { cwd: "/tmp", totalEstimatedTokens: 0 }],
      [() => client.reloadPackages(), true],
      [() => client.refreshCapabilities(), { hasSession: true }],
      [() => client.getPluginRuntime(), { hasSession: true }],
      [() => client.answerQuestion("call-1", "answer"), undefined],
      [() => client.listPlanReviews("c-1"), []],
      [() => client.resolvePlanReview({ reviewId: "review-1", versionId: "version-1", decision: "approved", annotations: [] }), { id: "review-1", status: "approved" }],
      [() => client.reset(), undefined],
      [() => client.testConfiguration(settings), "ok"],
      [() => client.updateConfiguration(), undefined],
    ];
    for (const [invoke, result] of cases) {
      const promise = invoke();
      const sentBefore = child.sent.length;
      await vi.waitFor(() => {
        expect(child.sent.length).toBeGreaterThan(sentBefore);
      });
      child.emit("message", { kind: "runtime.response", id: lastRequest(child).id, result });
      await expect(promise).resolves.toEqual(result);
    }
  });

  it("discards recovery records", async () => {
    const client = createClient();
    const child = lastChild();
    emitReady(child);

    const sending = client.send("do work", "/tmp", "c-1");
    await vi.waitFor(() => {
      expect(child.sent.some((message) => message.kind === "runtime.request")).toBe(true);
    });
    child.emit("message", { kind: "runtime.response", id: lastRequest(child).id, result: "run-1" });
    await sending;
    child.emit("exit", 1, null);

    const [record] = client.listRecoveries();
    expect(record).toMatchObject({ runId: "run-1", status: "interrupted" });
    client.discardRecovery(record.id);
    expect(client.listRecoveries()).toEqual([]);
  });

  it("retries an interrupted recovery as a continuation prompt", async () => {
    const client = createClient();
    emitReady(lastChild());

    const sending = client.send("original task", "/tmp", "c-1");
    await vi.waitFor(() => {
      expect(lastChild().sent.some((message) => message.kind === "runtime.request")).toBe(true);
    });
    lastChild().emit("message", { kind: "runtime.response", id: lastRequest(lastChild()).id, result: "run-1" });
    await sending;
    lastChild().emit("exit", 1, null);
    const [record] = client.listRecoveries();

    await vi.waitFor(() => {
      expect(children).toHaveLength(2);
    });
    emitReady(lastChild());
    const retrying = client.retryRecovery(record.id);
    await vi.waitFor(() => {
      expect(lastChild().sent.some((message) => message.kind === "runtime.request")).toBe(true);
    });
    const request = lastRequest(lastChild());
    expect(request.method).toBe("send");
    expect(request.args[0]).toContain("original task");
    expect(request.args[0]).toContain("interrupted");
    lastChild().emit("message", { kind: "runtime.response", id: request.id, result: "run-2" });
    lastChild().emit("message", { kind: "runtime.event", event: { type: "run.completed", runId: "run-2" } });
    await expect(retrying).resolves.toBe("run-2");
    expect(client.listRecoveries()).toEqual([]);
  });

  it("interrupts the active run and disconnects the worker when disposed", () => {
    const client = createClient();
    const child = lastChild();
    emitReady(child);
    child.emit("message", { kind: "runtime.event", event: { type: "run.started", runId: "run-1", conversationId: "c-1", provider: "openai", model: "gpt-test", cwd: "/tmp" } });
    expect(client.isRunning()).toBe(true);

    client.dispose();

    expect(child.connected).toBe(false);
    expect(client.isRunning()).toBe(true);
  });
});
