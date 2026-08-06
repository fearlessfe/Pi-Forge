import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
  runtimeProtocolVersion,
  validateRuntimeServerEnvelope,
  type AgentEvent,
  type ConversationExport,
  type ConversationHistoryDetail,
  type ConversationHistoryItem,
  type ConversationHistoryPage,
  type ConversationListQuery,
  type PlanReviewArtifact,
  type QueuedMessages,
  type ResolvePlanReviewInput,
  type SendPromptInput,
  type TaskFileChange,
} from "@pi-forge/runtime-contracts";
import type {
  ContextBudgetReport,
  PermissionRuntime,
  PluginRuntimeStatus,
  ProviderCatalogEntry,
  ResourceInventory,
  SaveModelSettings,
} from "../src/contracts.js";
import type { SettingsStore } from "./settings-store.js";
import type { McpService, McpToolDescriptor } from "./mcp-service.js";
import type { BrowserDebugPort } from "./browser-service.js";
import type { PromptExtras } from "./agent-service.js";
import {
  agentRuntimeProtocolVersion,
  createRuntimeHandshakeOffer,
  isHostCancel,
  isHostRequest,
  type AgentRuntimeInit,
  type AgentRuntimeMethod,
  type HostRequest,
  type HostResponse,
  type RuntimeRecoveryRecord,
  type RuntimeExecutionProfile,
  type RuntimeRequest,
  type RuntimeResponse,
} from "./agent-runtime-protocol.js";
import { RuntimeRecoveryStore } from "./runtime-recovery-store.js";

type PendingRequest = {
  method: AgentRuntimeMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout?: NodeJS.Timeout;
};

const crashLoopWindowMs = 60_000;
const crashLoopThreshold = 3;
const defaultHeartbeatIntervalMs = 5_000;
const defaultHeartbeatMissLimit = 3;
const defaultStartupTimeoutMs = 10_000;

function defaultRequestTimeout(method: AgentRuntimeMethod): number {
  if (method === "discoverModels" || method === "testConfiguration") return 30_000;
  if (method === "listConversations" || method === "listConversationPage" || method === "loadConversation") return 15_000;
  return 10_000;
}

export type RuntimeClientOptions = {
  workerPath: string;
  userDataPath: string;
  agentDir: string;
  fallbackCwd: string;
  sessionDir: string;
  settings: Pick<SettingsStore, "resolve">;
  credentials: CredentialStore;
  mcp: Pick<McpService, "tools" | "contextInventory" | "callTool">;
  browser: BrowserDebugPort;
  emit(event: AgentEvent): void;
  observe?(event: AgentEvent, prompt?: string): void;
  forkProcess?: typeof fork;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: Partial<Record<AgentRuntimeMethod, number>>;
  recoveryStore?: RuntimeRecoveryStore;
  initialProfile?: RuntimeExecutionProfile;
  /** Binds a dedicated worker to one conversation and rejects misrouted runs. */
  expectedConversationId?: string;
  /** Main-owned frozen run scope used to revalidate every privileged MCP call. */
  getActiveProfile?(): RuntimeExecutionProfile | undefined;
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
  private startingRecoveryId?: string;
  private crashTimestamps: number[] = [];
  private crashLooping = false;
  private unresponsive = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatId?: string;
  private heartbeatMisses = 0;
  private readyTimer?: NodeJS.Timeout;
  private conversationStateLoaded = false;
  private readonly finishedBeforeSendResponse = new Set<string>();

  constructor(private readonly options: RuntimeClientOptions) {
    this.recovery = options.recoveryStore ?? new RuntimeRecoveryStore(options.userDataPath);
    this.start();
  }

  isRunning(): boolean {
    return Boolean(this.activeRunId);
  }

  needsHistoryReload(): boolean {
    return !this.conversationStateLoaded;
  }

  async getModelCatalog(allowNetwork = true): Promise<ProviderCatalogEntry[]> {
    return this.request("getModelCatalog", allowNetwork);
  }

  async discoverModels(input: SaveModelSettings) {
    return this.request<Awaited<ReturnType<import("./agent-service.js").AgentService["discoverModels"]>>>("discoverModels", input);
  }

  async send(prompt: string, cwd?: string, conversationId?: string, extras?: PromptExtras): Promise<string> {
    const input: SendPromptInput = { prompt, cwd, conversationId, images: extras?.images, attachments: extras?.attachments };
    const recovery = this.recovery.begin(input);
    this.startingRecoveryId = recovery.id;
    this.pendingPrompt = prompt;
    try {
      // extras 仅在有附件时追加，保持旧协议调用的参数形状不变。
      const args: unknown[] = [prompt, cwd, conversationId];
      if (extras?.images?.length || extras?.attachments?.length) args.push(extras);
      const runId = await this.request<string>("send", ...args);
      this.conversationStateLoaded = true;
      if (this.finishedBeforeSendResponse.delete(runId)) {
        this.recovery.discard(recovery.id);
      } else {
        this.activeRunId = runId;
        this.recovery.attachRun(recovery.id, runId);
      }
      this.startingRecoveryId = undefined;
      return runId;
    } catch (error) {
      this.recovery.interruptRecord(recovery.id, error instanceof Error ? error.message : String(error));
      this.startingRecoveryId = undefined;
      throw error;
    } finally {
      this.pendingPrompt = undefined;
    }
  }

  executeExtensionCommand(prompt: string, cwd?: string, conversationId?: string): Promise<boolean> {
    return this.request("executeExtensionCommand", prompt, cwd, conversationId);
  }

  listConversations(): Promise<ConversationHistoryItem[]> { return this.request("listConversations"); }
  listConversationPage(query?: ConversationListQuery): Promise<ConversationHistoryPage> { return this.request("listConversationPage", query); }
  async loadConversation(id: string): Promise<ConversationHistoryDetail> {
    const conversation = await this.request<ConversationHistoryDetail>("loadConversation", id);
    this.conversationStateLoaded = true;
    return conversation;
  }
  forkConversation(id: string, entryId?: string): Promise<ConversationHistoryItem> { return this.request("forkConversation", id, entryId); }
  exportConversation(id: string, format: "markdown" | "json"): Promise<ConversationExport> { return this.request("exportConversation", id, format); }
  setConversationArchived(id: string, archived: boolean): Promise<void> { return this.request("setConversationArchived", id, archived); }
  setConversationTags(id: string, tags: string[]): Promise<void> { return this.request("setConversationTags", id, tags); }
  renameConversation(id: string, title: string): Promise<void> { return this.request("renameConversation", id, title); }
  deleteConversation(id: string): Promise<void> { return this.request("deleteConversation", id); }
  abort(): Promise<void> { return this.request("abort"); }
  queueMessage(prompt: string, mode: "steer" | "followUp", extras?: PromptExtras): Promise<QueuedMessages> {
    const args: unknown[] = [prompt, mode];
    if (extras?.images?.length || extras?.attachments?.length) args.push(extras);
    return this.request("queueMessage", ...args);
  }
  clearQueue(): Promise<QueuedMessages> { return this.request("clearQueue"); }
  listChanges(runId?: string): Promise<TaskFileChange[]> { return this.request("listChanges", runId); }
  changePath(changeId: string): Promise<string> { return this.request("changePath", changeId); }
  acceptChanges(changeIds?: string[]): Promise<TaskFileChange[]> { return this.request("acceptChanges", changeIds); }
  revertChanges(changeIds?: string[]): Promise<TaskFileChange[]> { return this.request("revertChanges", changeIds); }
  getPermissionRuntime(): Promise<PermissionRuntime> { return this.request("getPermissionRuntime"); }
  getResourceInventory(cwd?: string): Promise<ResourceInventory> { return this.request("getResourceInventory", cwd); }
  getContextBudget(cwd?: string): Promise<ContextBudgetReport> { return this.request("getContextBudget", cwd); }
  reloadPackages(): Promise<boolean> { return this.request("reloadPackages"); }
  refreshCapabilities(): Promise<PluginRuntimeStatus> { return this.request("refreshCapabilities"); }
  getPluginRuntime(): Promise<PluginRuntimeStatus> { return this.request("getPluginRuntime"); }
  answerQuestion(callId: string, answer: string): Promise<void> { return this.request("answerQuestion", callId, answer); }
  listPlanReviews(conversationId?: string): Promise<PlanReviewArtifact[]> { return this.request("listPlanReviews", conversationId); }
  resolvePlanReview(input: ResolvePlanReviewInput): Promise<PlanReviewArtifact> { return this.request("resolvePlanReview", input); }
  async reset(): Promise<void> {
    await this.request("reset");
    this.conversationStateLoaded = false;
  }
  testConfiguration(input: SaveModelSettings): Promise<string> { return this.request("testConfiguration", input); }

  async updateConfiguration(profile?: RuntimeExecutionProfile): Promise<void> {
    await this.request("updateConfiguration", profile ?? {
      modelSettings: this.options.settings.resolve(),
      cwd: this.options.fallbackCwd,
      resourceSelectionMode: "inherit",
      selectedSkills: [],
      selectedMcpServers: [],
    });
    // The worker applies configuration by resetting AgentService, including
    // its session and FileChangeTracker snapshots.
    this.conversationStateLoaded = false;
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
      "If a request_plan_review call was interrupted, submit the same full plan again; Pi Forge will reuse its persisted version and any existing decision.",
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

  async retryAfterCrashLoop(): Promise<void> {
    this.crashTimestamps = [];
    this.crashLooping = false;
    this.unresponsive = false;
    this.restartAttempt = 0;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.stopChild(true);
    this.start();
    await this.ready;
    this.options.emit({ type: "runtime.status", status: "running" });
  }

  dispose(): void {
    this.disposing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.clearHeartbeat();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.activeRunId) this.recovery.interruptRun(this.activeRunId, "应用已退出；任务可以在下次启动后继续。");
    if (this.startingRecoveryId) this.recovery.interruptRecord(this.startingRecoveryId, "应用已退出；任务可以在下次启动后继续。");
    this.stopChild(true);
  }

  private start(): void {
    if (this.disposing || this.child) return;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Requests await this promise; mark it handled so a worker exit without
    // pending requests is not reported as an unhandled rejection.
    void this.ready.catch(() => undefined);
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
    child.on("message", (message: unknown) => this.handleMessage(child, message));
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(`Agent Runtime exited (${signal ?? code ?? "unknown"}).`)));
    const init: AgentRuntimeInit = {
      ...createRuntimeHandshakeOffer(),
      userDataPath: this.options.userDataPath,
      agentDir: this.options.agentDir,
      fallbackCwd: this.options.fallbackCwd,
      sessionDir: this.options.sessionDir,
      modelSettings: this.options.settings.resolve(),
      resourceProfile: this.options.initialProfile,
    };
    const startupTimeoutMs = this.options.startupTimeoutMs ?? defaultStartupTimeoutMs;
    if (startupTimeoutMs > 0) {
      this.readyTimer = setTimeout(() => {
        this.readyTimer = undefined;
        this.markUnresponsive(child, "Agent Runtime 启动超时，未完成协议握手。");
      }, startupTimeoutMs);
    }
    child.send({ kind: "runtime.init", value: init });
  }

  private async request<T>(method: AgentRuntimeMethod, ...args: unknown[]): Promise<T> {
    if (this.crashLooping) throw new Error("Agent Runtime 连续崩溃，已停止自动重启。请点击界面中的“重试”按钮重新启动。");
    if (this.unresponsive) throw new Error("Agent Runtime 无响应。请点击界面中的“重试”按钮重新启动。");
    await this.ready;
    const child = this.child;
    if (!child?.connected) throw new Error("Agent Runtime 当前不可用，正在重新启动。");
    const id = randomUUID();
    const request: RuntimeRequest = { kind: "runtime.request", protocolVersion: runtimeProtocolVersion, id, method, args };
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs?.[method] ?? defaultRequestTimeout(method);
      const pending: PendingRequest = { method, resolve: (value) => resolve(value as T), reject };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          const error = new Error(`Agent Runtime 请求超时（${method}，${timeoutMs}ms）。`);
          reject(error);
          if (method === "send") this.markUnresponsive(child, "Agent Runtime 未及时确认任务启动；为避免迟到任务产生副作用，已停止该 Runtime。");
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      child.send(request, (error) => {
        if (!error) return;
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        reject(error);
      });
    });
  }

  private handleMessage(child: ChildProcess, input: unknown): void {
    // A killed or disconnected worker may still have messages queued in the
    // parent event loop. Never let a previous generation resolve the current
    // ready promise, mutate run state, or invoke privileged host handlers.
    if (this.child !== child) return;
    if (isHostCancel(input)) {
      this.hostRequests.get(input.id)?.abort();
      return;
    }
    if (isHostRequest(input)) {
      void this.handleHostRequest(input);
      return;
    }
    const parsed = validateRuntimeServerEnvelope(input);
    if (!parsed.success) {
      const detail = parsed.error.code === "incompatible_version" ? "协议版本不兼容" : "收到畸形或未知协议消息";
      this.markUnresponsive(child, `Agent Runtime ${detail}，已拒绝该 Runtime。`);
      return;
    }
    const message = parsed.value;
    if (message.kind === "runtime.ready") {
      if (message.protocolVersion !== agentRuntimeProtocolVersion) {
        this.markUnresponsive(child, "Agent Runtime 协议版本不兼容。");
        return;
      }
      const required = createRuntimeHandshakeOffer().requiredCapabilities;
      const missing = required.filter((capability) => !message.capabilities.includes(capability));
      if (missing.length > 0) {
        this.markUnresponsive(child, `Agent Runtime 缺少必需能力：${missing.join(", ")}。`);
        return;
      }
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      this.restartAttempt = 0;
      this.unresponsive = false;
      this.resolveReady?.();
      this.startHeartbeat();
      return;
    }
    if (message.kind === "runtime.pong") {
      if (message.id === this.heartbeatId) {
        this.heartbeatId = undefined;
        this.heartbeatMisses = 0;
      }
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
  }

  private handleResponse(message: RuntimeResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (message.error) pending.reject(runtimeError(message.error));
    else pending.resolve(message.result);
  }

  private handleEvent(event: AgentEvent): void {
    this.options.observe?.(event, event.type === "run.started" ? this.pendingPrompt : undefined);
    if (event.type === "run.started") {
      const expectedConversationId = this.options.expectedConversationId;
      if (expectedConversationId && event.conversationId !== expectedConversationId) {
        const message = "Runtime 返回了不匹配的会话 ID；该 Runtime 已停止，事件已隔离。";
        this.options.emit({ type: "run.error", conversationId: expectedConversationId, runId: event.runId, message });
        if (this.child) this.markUnresponsive(this.child, message);
        return;
      }
      this.activeRunId = event.runId;
      this.conversationStateLoaded = true;
    }
    if (event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.error") {
      const stale = Boolean(this.activeRunId && event.runId !== this.activeRunId);
      if (this.startingRecoveryId) {
        this.finishedBeforeSendResponse.add(event.runId);
        if (this.finishedBeforeSendResponse.size > 32) this.finishedBeforeSendResponse.delete(this.finishedBeforeSendResponse.values().next().value!);
      }
      if (!stale && event.runId === this.activeRunId) this.activeRunId = undefined;
      this.recovery.completeRun(event.runId);
      if (stale) return;
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
        case "mcp.tools": {
          const profile = this.options.getActiveProfile?.();
          const tools = await this.options.mcp.tools(request.args[0] as string | undefined, profile?.resourceSelectionMode === "custom" ? profile.selectedMcpServers : undefined);
          result = profile?.resourceSelectionMode === "custom" ? tools.filter((tool) => profile.selectedMcpServers.includes(tool.serverKey)) : tools;
          break;
        }
        case "mcp.contextInventory": {
          const profile = this.options.getActiveProfile?.();
          const inventory = await this.options.mcp.contextInventory(request.args[0] as string | undefined, profile?.resourceSelectionMode === "custom" ? profile.selectedMcpServers : undefined);
          result = profile?.resourceSelectionMode === "custom" ? inventory.filter((entry) => profile.selectedMcpServers.includes(entry.key)) : inventory;
          break;
        }
        case "mcp.callTool": {
          const descriptor = request.args[0] as McpToolDescriptor;
          const profile = this.options.getActiveProfile?.();
          if (profile?.resourceSelectionMode === "custom" && !profile.selectedMcpServers.includes(descriptor.serverKey)) throw new Error("当前会话未授权该 MCP Server。");
          // Fetching the current effective tool list revalidates global/project enablement and trust.
          if (profile) {
            const effective = await this.options.mcp.tools(profile.cwd, profile.resourceSelectionMode === "custom" ? profile.selectedMcpServers : undefined);
            if (!effective.some((tool) => tool.serverKey === descriptor.serverKey && tool.name === descriptor.name && tool.remoteName === descriptor.remoteName)) {
              throw new Error("MCP 工具已被禁用、项目不受信任或不属于当前会话。");
            }
          }
          result = await this.options.mcp.callTool(descriptor, request.args[1] as Record<string, unknown>, controller.signal);
          break;
        }
        case "browser.startAnnotation": result = await this.options.browser.startAnnotation(
          request.args[0] as string | undefined,
          request.args[1] as string | undefined,
          controller.signal,
          `agent:${this.options.expectedConversationId ?? "runtime"}`,
        ); break;
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
    this.conversationStateLoaded = false;
    this.clearHeartbeat();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.rejectReady?.(error);
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const controller of this.hostRequests.values()) controller.abort();
    this.hostRequests.clear();
    const interruptedRunId = this.activeRunId;
    const message = "Agent Runtime 异常退出。任务状态已保存，可在 Runtime 恢复栏中继续。";
    if (interruptedRunId) this.recovery.interruptRun(interruptedRunId, message);
    else if (this.startingRecoveryId) this.recovery.interruptRecord(this.startingRecoveryId, message);
    this.startingRecoveryId = undefined;
    if (interruptedRunId) {
      this.activeRunId = undefined;
      this.options.emit({ type: "run.error", runId: interruptedRunId, message });
    }
    if (this.disposing) return;
    if (this.recordCrash()) {
      this.options.emit({ type: "runtime.status", status: "crash-looping" });
      return;
    }
    this.restartAttempt += 1;
    const delay = Math.min(5_000, 250 * 2 ** Math.min(this.restartAttempt - 1, 4));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
  }

  private recordCrash(): boolean {
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((timestamp) => now - timestamp < crashLoopWindowMs);
    this.crashTimestamps.push(now);
    if (this.crashTimestamps.length < crashLoopThreshold) return false;
    this.crashLooping = true;
    return true;
  }

  private stopChild(disconnect: boolean): void {
    const child = this.child;
    this.child = undefined;
    this.conversationStateLoaded = false;
    this.clearHeartbeat();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    if (!child) return;
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    if (disconnect && child.connected) child.disconnect();
    else child.kill();
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Agent Runtime 已重新启动。"));
    }
    this.pending.clear();
    for (const controller of this.hostRequests.values()) controller.abort();
    this.hostRequests.clear();
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const intervalMs = this.options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
    if (intervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), intervalMs);
  }

  private heartbeatTick(): void {
    const child = this.child;
    if (!child?.connected || this.unresponsive) return;
    if (this.heartbeatId) {
      this.heartbeatMisses += 1;
      const missLimit = Math.max(1, this.options.heartbeatMissLimit ?? defaultHeartbeatMissLimit);
      if (this.heartbeatMisses >= missLimit) {
        this.markUnresponsive(child, "Agent Runtime 心跳连续超时，进程可能无响应。");
      }
      return;
    }
    const id = randomUUID();
    this.heartbeatId = id;
    this.heartbeatMisses = 1;
    child.send({ kind: "runtime.ping", protocolVersion: runtimeProtocolVersion, id }, (error) => {
      if (error) this.markUnresponsive(child, `Agent Runtime 心跳发送失败：${error.message}`);
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatId = undefined;
    this.heartbeatMisses = 0;
  }

  private markUnresponsive(child: ChildProcess, message: string): void {
    if (this.child !== child || this.unresponsive || this.disposing) return;
    this.unresponsive = true;
    this.clearHeartbeat();
    const error = new Error(message);
    this.rejectReady?.(error);
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const controller of this.hostRequests.values()) controller.abort();
    this.hostRequests.clear();
    const interruptedRunId = this.activeRunId;
    if (interruptedRunId) this.recovery.interruptRun(interruptedRunId, message);
    else if (this.startingRecoveryId) this.recovery.interruptRecord(this.startingRecoveryId, message);
    if (interruptedRunId) {
      this.activeRunId = undefined;
      this.options.emit({ type: "run.error", runId: interruptedRunId, message });
    }
    this.options.emit({ type: "runtime.status", status: "unresponsive" });
    this.stopChild(true);
  }
}
