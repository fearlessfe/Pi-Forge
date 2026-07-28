import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  ConversationExport,
  ConversationHistoryDetail,
  ConversationHistoryItem,
  PermissionRuntime,
  PluginRuntimeStatus,
  ProviderCatalogEntry,
  QueuedMessages,
  ResourceInventory,
  SaveModelSettings,
  SendPromptInput,
  TaskFileChange,
} from "../src/contracts.js";
import type { SettingsStore } from "./settings-store.js";
import type { McpService, McpToolDescriptor } from "./mcp-service.js";
import type { BrowserDebugPort } from "./browser-service.js";
import {
  agentRuntimeProtocolVersion,
  type AgentRuntimeInit,
  type AgentRuntimeMethod,
  type HostRequest,
  type HostResponse,
  type RuntimeRecoveryRecord,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeToParentMessage,
} from "./agent-runtime-protocol.js";
import { RuntimeRecoveryStore } from "./runtime-recovery-store.js";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type RuntimeClientOptions = {
  workerPath: string;
  userDataPath: string;
  agentDir: string;
  fallbackCwd: string;
  sessionDir: string;
  settings: Pick<SettingsStore, "resolve">;
  credentials: CredentialStore;
  mcp: Pick<McpService, "tools" | "callTool">;
  browser: BrowserDebugPort;
  emit(event: AgentEvent): void;
  observe?(event: AgentEvent, prompt?: string): void;
  forkProcess?: typeof fork;
};

function runtimeError(error: { message: string; stack?: string }): Error {
  const result = new Error(error.message);
  if (error.stack) result.stack = error.stack;
  return result;
}

export class AgentRuntimeClient {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly hostRequests = new Map<string, AbortController>();
  private readonly recovery: RuntimeRecoveryStore;
  private activeRunId?: string;
  private disposing = false;
  private restartTimer?: NodeJS.Timeout;
  private restartAttempt = 0;
  private pendingPrompt?: string;

  constructor(private readonly options: RuntimeClientOptions) {
    this.recovery = new RuntimeRecoveryStore(options.userDataPath);
    this.start();
  }

  isRunning(): boolean {
    return Boolean(this.activeRunId);
  }

  async getModelCatalog(allowNetwork = true): Promise<ProviderCatalogEntry[]> {
    return this.request("getModelCatalog", allowNetwork);
  }

  async discoverModels(input: SaveModelSettings) {
    return this.request<Awaited<ReturnType<import("./agent-service.js").AgentService["discoverModels"]>>>("discoverModels", input);
  }

  async send(prompt: string, cwd?: string, conversationId?: string): Promise<string> {
    const input: SendPromptInput = { prompt, cwd, conversationId };
    const recovery = this.recovery.begin(input);
    this.pendingPrompt = prompt;
    try {
      const runId = await this.request<string>("send", prompt, cwd, conversationId);
      this.activeRunId = runId;
      this.recovery.attachRun(recovery.id, runId);
      return runId;
    } catch (error) {
      this.recovery.interruptRun(undefined, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.pendingPrompt = undefined;
    }
  }

  executeExtensionCommand(prompt: string, cwd?: string, conversationId?: string): Promise<boolean> {
    return this.request("executeExtensionCommand", prompt, cwd, conversationId);
  }

  listConversations(): Promise<ConversationHistoryItem[]> { return this.request("listConversations"); }
  loadConversation(id: string): Promise<ConversationHistoryDetail> { return this.request("loadConversation", id); }
  forkConversation(id: string, entryId?: string): Promise<ConversationHistoryItem> { return this.request("forkConversation", id, entryId); }
  exportConversation(id: string, format: "markdown" | "json"): Promise<ConversationExport> { return this.request("exportConversation", id, format); }
  setConversationArchived(id: string, archived: boolean): Promise<void> { return this.request("setConversationArchived", id, archived); }
  setConversationTags(id: string, tags: string[]): Promise<void> { return this.request("setConversationTags", id, tags); }
  renameConversation(id: string, title: string): Promise<void> { return this.request("renameConversation", id, title); }
  deleteConversation(id: string): Promise<void> { return this.request("deleteConversation", id); }
  abort(): Promise<void> { return this.request("abort"); }
  queueMessage(prompt: string, mode: "steer" | "followUp"): Promise<QueuedMessages> { return this.request("queueMessage", prompt, mode); }
  clearQueue(): Promise<QueuedMessages> { return this.request("clearQueue"); }
  listChanges(runId?: string): Promise<TaskFileChange[]> { return this.request("listChanges", runId); }
  changePath(changeId: string): Promise<string> { return this.request("changePath", changeId); }
  acceptChanges(changeIds?: string[]): Promise<TaskFileChange[]> { return this.request("acceptChanges", changeIds); }
  revertChanges(changeIds?: string[]): Promise<TaskFileChange[]> { return this.request("revertChanges", changeIds); }
  getPermissionRuntime(): Promise<PermissionRuntime> { return this.request("getPermissionRuntime"); }
  getResourceInventory(cwd?: string): Promise<ResourceInventory> { return this.request("getResourceInventory", cwd); }
  reloadPackages(): Promise<boolean> { return this.request("reloadPackages"); }
  refreshCapabilities(): Promise<PluginRuntimeStatus> { return this.request("refreshCapabilities"); }
  getPluginRuntime(): Promise<PluginRuntimeStatus> { return this.request("getPluginRuntime"); }
  answerQuestion(callId: string, answer: string): Promise<void> { return this.request("answerQuestion", callId, answer); }
  reset(): Promise<void> { return this.request("reset"); }
  testConfiguration(input: SaveModelSettings): Promise<string> { return this.request("testConfiguration", input); }

  async updateConfiguration(): Promise<void> {
    await this.request("updateConfiguration", this.options.settings.resolve());
  }

  listRecoveries(): RuntimeRecoveryRecord[] {
    return this.recovery.list();
  }

  discardRecovery(id: string): void {
    this.recovery.discard(id);
  }

  async retryRecovery(id: string): Promise<string> {
    const record = this.recovery.get(id);
    this.recovery.discard(id);
    const continuation = [
      "Continue the task that was interrupted when the Agent Runtime exited.",
      "Inspect the existing conversation and workspace before making changes; do not repeat completed tool actions.",
      "Original request:",
      record.input.prompt,
    ].join("\n\n");
    return this.send(continuation, record.input.cwd, record.input.conversationId);
  }

  async restart(): Promise<void> {
    this.stopChild(false);
    this.start();
    await this.ready;
  }

  dispose(): void {
    this.disposing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.activeRunId) this.recovery.interruptRun(this.activeRunId, "应用已退出；任务可以在下次启动后继续。");
    this.stopChild(true);
  }

  private start(): void {
    if (this.disposing || this.child) return;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const child = this.options.forkProcess?.(this.options.workerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
    }) ?? fork(this.options.workerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => process.stdout.write(`[agent-runtime] ${String(chunk)}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[agent-runtime] ${String(chunk)}`));
    child.on("message", (message: RuntimeToParentMessage) => this.handleMessage(message));
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(`Agent Runtime exited (${signal ?? code ?? "unknown"}).`)));
    const init: AgentRuntimeInit = {
      protocolVersion: agentRuntimeProtocolVersion,
      userDataPath: this.options.userDataPath,
      agentDir: this.options.agentDir,
      fallbackCwd: this.options.fallbackCwd,
      sessionDir: this.options.sessionDir,
      modelSettings: this.options.settings.resolve(),
    };
    child.send({ kind: "runtime.init", value: init });
  }

  private async request<T>(method: AgentRuntimeMethod, ...args: unknown[]): Promise<T> {
    await this.ready;
    const child = this.child;
    if (!child?.connected) throw new Error("Agent Runtime 当前不可用，正在重新启动。");
    const id = randomUUID();
    const request: RuntimeRequest = { kind: "runtime.request", id, method, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      child.send(request, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleMessage(message: RuntimeToParentMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.kind === "runtime.ready") {
      if (message.protocolVersion !== agentRuntimeProtocolVersion) {
        this.rejectReady?.(new Error("Agent Runtime 协议版本不兼容。"));
        return;
      }
      this.restartAttempt = 0;
      this.resolveReady?.();
      return;
    }
    if (message.kind === "runtime.response") {
      this.handleResponse(message);
      return;
    }
    if (message.kind === "runtime.event") {
      this.handleEvent(message.event);
      return;
    }
    if (message.kind === "host.cancel") {
      this.hostRequests.get(message.id)?.abort();
      return;
    }
    if (message.kind === "host.request") void this.handleHostRequest(message);
  }

  private handleResponse(message: RuntimeResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(runtimeError(message.error));
    else pending.resolve(message.result);
  }

  private handleEvent(event: AgentEvent): void {
    this.options.observe?.(event, event.type === "run.started" ? this.pendingPrompt : undefined);
    if (event.type === "run.started") this.activeRunId = event.runId;
    if (event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.error") {
      this.activeRunId = undefined;
      this.recovery.completeRun(event.runId);
    }
    this.options.emit(event);
  }

  private async handleHostRequest(request: HostRequest): Promise<void> {
    const child = this.child;
    const controller = new AbortController();
    this.hostRequests.set(request.id, controller);
    let response: HostResponse;
    try {
      let result: unknown;
      switch (request.method) {
        case "credential.read": result = await this.options.credentials.read(request.args[0] as string); break;
        case "credential.list": result = await this.options.credentials.list(); break;
        case "credential.write": {
          const providerId = request.args[0] as string;
          const credential = request.args[1] as Credential;
          result = await this.options.credentials.modify(providerId, async () => credential);
          break;
        }
        case "credential.delete": result = await this.options.credentials.delete(request.args[0] as string); break;
        case "mcp.tools": result = await this.options.mcp.tools(request.args[0] as string | undefined); break;
        case "mcp.callTool": result = await this.options.mcp.callTool(request.args[0] as McpToolDescriptor, request.args[1] as Record<string, unknown>, controller.signal); break;
        case "browser.startAnnotation": result = await this.options.browser.startAnnotation(request.args[0] as string | undefined, request.args[1] as string | undefined, controller.signal); break;
      }
      response = { kind: "host.response", id: request.id, result };
    } catch (error) {
      response = { kind: "host.response", id: request.id, error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      } };
    }
    this.hostRequests.delete(request.id);
    if (child === this.child && child?.connected) child.send(response);
  }

  private handleExit(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.rejectReady?.(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const controller of this.hostRequests.values()) controller.abort();
    this.hostRequests.clear();
    const interruptedRunId = this.activeRunId;
    const message = "Agent Runtime 异常退出。任务状态已保存，可在 Runtime 恢复栏中继续。";
    this.recovery.interruptRun(undefined, message);
    if (interruptedRunId) {
      this.activeRunId = undefined;
      this.options.emit({ type: "run.error", runId: interruptedRunId, message });
    }
    if (this.disposing) return;
    this.restartAttempt += 1;
    const delay = Math.min(5_000, 250 * 2 ** Math.min(this.restartAttempt - 1, 4));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
  }

  private stopChild(disconnect: boolean): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    if (disconnect && child.connected) child.disconnect();
    else child.kill();
    for (const pending of this.pending.values()) pending.reject(new Error("Agent Runtime 已重新启动。"));
    this.pending.clear();
    for (const controller of this.hostRequests.values()) controller.abort();
    this.hostRequests.clear();
  }
}
