import type {
  AgentEvent,
  ContextBudgetReport,
  ConversationExecutionProfile,
  ConversationExport,
  ConversationHistoryDetail,
  ConversationHistoryItem,
  ConversationHistoryPage,
  ConversationListQuery,
  PermissionRuntime,
  PlanReviewArtifact,
  PluginRuntimeStatus,
  ProviderCatalogEntry,
  QueuedMessages,
  ResolvePlanReviewInput,
  SaveConversationExecutionProfile,
  SaveModelSettings,
  TaskFileChange,
} from "../src/contracts.js";
import { AgentRuntimeClient, type RuntimeClientOptions } from "./agent-runtime-client.js";
import type { PromptExtras } from "./agent-service.js";
import type { RuntimeExecutionProfile } from "./agent-runtime-protocol.js";
import { ConversationProfileStore } from "./conversation-profile-store.js";
import type { ResourceStore } from "./resource-store.js";
import { RuntimeRecoveryStore } from "./runtime-recovery-store.js";

type PoolOptions = Omit<RuntimeClientOptions, "emit" | "recoveryStore" | "initialProfile" | "getActiveProfile"> & {
  emit(event: AgentEvent): void;
  profiles: ConversationProfileStore;
  resources: Pick<ResourceStore, "getProjectSettings">;
  maxParallel?: number;
};

type ClientEntry = {
  client: AgentRuntimeClient;
  lastUsed: number;
  activeProfile?: RuntimeExecutionProfile;
};

const controlConversationId = "__pi_desktop_control__";

/**
 * Main-owned supervisor. A conversation is never multiplexed onto another
 * conversation's AgentService: every active run has a dedicated child worker.
 */
export class AgentRuntimePool {
  private readonly clients = new Map<string, ClientEntry>();
  private readonly recovery: RuntimeRecoveryStore;
  private control?: ClientEntry;
  private disposing = false;
  private readonly starting = new Set<string>();

  constructor(private readonly options: PoolOptions) {
    this.recovery = new RuntimeRecoveryStore(options.userDataPath);
  }

  isRunning(conversationId?: string): boolean {
    if (conversationId) return this.clients.get(conversationId)?.client.isRunning() ?? false;
    return [...this.clients.values()].some((entry) => entry.client.isRunning());
  }

  getProfile(conversationId: string, cwd = this.options.fallbackCwd): ConversationExecutionProfile {
    return this.options.profiles.ensure(conversationId, cwd, this.defaultModel(), this.options.resources.getProjectSettings(cwd));
  }

  saveProfile(input: SaveConversationExecutionProfile): ConversationExecutionProfile {
    // SettingsStore is the authoritative validator and credential resolver. The
    // returned apiKey is intentionally discarded before persistence.
    this.options.settings.resolve(input);
    return this.options.profiles.save(input);
  }

  async send(prompt: string, cwd: string | undefined, conversationId: string, extras?: PromptExtras): Promise<string> {
    if (!conversationId) throw new Error("启动任务必须指定会话 ID。");
    if (this.starting.has(conversationId) || this.clients.get(conversationId)?.client.isRunning()) throw new Error("该会话已有任务在运行。");
    const runningCount = [...this.clients.entries()].filter(([id, entry]) => entry.client.isRunning() || this.starting.has(id)).length;
    if (runningCount >= (this.options.maxParallel ?? 3)) {
      throw new Error(`当前已有 ${runningCount} 个会话在运行；最多可并行 ${this.options.maxParallel ?? 3} 个，请等待其中一个完成。`);
    }
    const profile = this.getProfile(conversationId, cwd);
    const entry = this.conversationClient(conversationId, profile);
    const snapshot = this.runtimeProfile(profile);
    entry.activeProfile = snapshot;
    entry.lastUsed = Date.now();
    this.starting.add(conversationId);
    try {
      await entry.client.updateConfiguration(snapshot);
      return await entry.client.send(prompt, profile.cwd, conversationId, extras);
    } finally {
      this.starting.delete(conversationId);
    }
  }

  async executeExtensionCommand(prompt: string, cwd?: string, conversationId?: string): Promise<boolean> {
    if (conversationId) {
      const profile = this.getProfile(conversationId, cwd);
      const entry = this.conversationClient(conversationId, profile);
      if (!entry.client.isRunning()) await entry.client.updateConfiguration(this.runtimeProfile(profile));
      return entry.client.executeExtensionCommand(prompt, profile.cwd, conversationId);
    }
    return this.controlClient().executeExtensionCommand(prompt, cwd);
  }

  getModelCatalog(allowNetwork = true): Promise<ProviderCatalogEntry[]> { return this.controlClient().getModelCatalog(allowNetwork); }
  discoverModels(input: SaveModelSettings) { return this.controlClient().discoverModels(input); }
  testConfiguration(input: SaveModelSettings): Promise<string> { return this.controlClient().testConfiguration(input); }
  getPermissionRuntime(): Promise<PermissionRuntime> { return this.controlClient().getPermissionRuntime(); }
  getResourceInventory(cwd?: string) { return this.controlClient().getResourceInventory(cwd); }
  getContextBudget(cwd?: string): Promise<ContextBudgetReport> { return this.controlClient().getContextBudget(cwd); }
  getPluginRuntime(): Promise<PluginRuntimeStatus> { return this.controlClient().getPluginRuntime(); }
  refreshCapabilities(): Promise<PluginRuntimeStatus> { return this.controlClient().refreshCapabilities(); }
  reloadPackages(): Promise<boolean> { return this.controlClient().reloadPackages(); }
  listConversations(): Promise<ConversationHistoryItem[]> { return this.controlClient().listConversations(); }
  listConversationPage(query?: ConversationListQuery): Promise<ConversationHistoryPage> { return this.controlClient().listConversationPage(query); }
  loadConversation(id: string): Promise<ConversationHistoryDetail> { return this.clientForRead(id).loadConversation(id); }
  renameConversation(id: string, title: string): Promise<void> { return this.clientForRead(id).renameConversation(id, title); }
  forkConversation(id: string, entryId?: string): Promise<ConversationHistoryItem> { return this.clientForRead(id).forkConversation(id, entryId); }
  exportConversation(id: string, format: "markdown" | "json"): Promise<ConversationExport> { return this.clientForRead(id).exportConversation(id, format); }
  setConversationTags(id: string, tags: string[]): Promise<void> { return this.clientForRead(id).setConversationTags(id, tags); }

  async setConversationArchived(id: string, archived: boolean): Promise<void> {
    await this.stopAndRelease(id);
    return this.controlClient().setConversationArchived(id, archived);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.stopAndRelease(id);
    await this.controlClient().deleteConversation(id);
    this.options.profiles.delete(id);
  }

  abort(conversationId: string): Promise<void> { return this.requireConversation(conversationId).abort(); }
  queueMessage(conversationId: string, prompt: string, mode: "steer" | "followUp", extras?: PromptExtras): Promise<QueuedMessages> {
    return this.requireConversation(conversationId).queueMessage(prompt, mode, extras);
  }
  clearQueue(conversationId: string): Promise<QueuedMessages> { return this.requireConversation(conversationId).clearQueue(); }

  async listChanges(conversationId: string, runId?: string): Promise<TaskFileChange[]> {
    const client = await this.clientWithHistory(conversationId);
    return client.listChanges(runId);
  }
  async changePath(conversationId: string, changeId: string): Promise<string> { return (await this.clientWithHistory(conversationId)).changePath(changeId); }
  async acceptChanges(conversationId: string, changeIds?: string[]): Promise<TaskFileChange[]> { return (await this.clientWithHistory(conversationId)).acceptChanges(changeIds); }
  async revertChanges(conversationId: string, changeIds?: string[]): Promise<TaskFileChange[]> { return (await this.clientWithHistory(conversationId)).revertChanges(changeIds); }
  answerQuestion(conversationId: string, callId: string, answer: string): Promise<void> { return this.requireConversation(conversationId).answerQuestion(callId, answer); }
  listPlanReviews(conversationId?: string): Promise<PlanReviewArtifact[]> { return this.clientForRead(conversationId).listPlanReviews(conversationId); }
  resolvePlanReview(conversationId: string, input: ResolvePlanReviewInput): Promise<PlanReviewArtifact> { return this.requireConversation(conversationId).resolvePlanReview(input); }

  async reset(conversationId?: string): Promise<void> {
    if (conversationId) {
      const entry = this.clients.get(conversationId);
      if (entry && !entry.client.isRunning()) await entry.client.reset();
      return;
    }
    await Promise.all([...this.clients.values(), ...(this.control ? [this.control] : [])]
      .filter((entry) => !entry.client.isRunning()).map((entry) => entry.client.reset()));
  }

  async updateConfiguration(): Promise<void> {
    if (this.control && !this.control.client.isRunning()) await this.control.client.updateConfiguration();
  }

  listRecoveries() { return this.recovery.list(); }
  discardRecovery(id: string): void { this.recovery.discard(id); }
  async retryRecovery(id: string): Promise<string> {
    const record = this.recovery.get(id);
    const conversationId = record.input.conversationId;
    if (!conversationId) throw new Error("旧恢复记录缺少会话 ID，无法安全路由；请丢弃后重新发送。");
    const continuation = [
      "Continue the task that was interrupted when the Agent Runtime exited.",
      "Inspect the existing conversation and workspace before making changes; do not repeat completed tool actions.",
      "If a request_plan_review call was interrupted, submit the same full plan again; Pi Forge will reuse its persisted version and any existing decision.",
      "Original request:",
      record.input.prompt,
    ].join("\n\n");
    const runId = await this.send(continuation, record.input.cwd, conversationId);
    this.recovery.discard(id);
    return runId;
  }

  async retryAfterCrashLoop(conversationId?: string): Promise<void> {
    if (conversationId) return this.requireConversation(conversationId).retryAfterCrashLoop();
    if (this.control) await this.control.client.retryAfterCrashLoop();
  }

  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    for (const entry of this.clients.values()) entry.client.dispose();
    this.clients.clear();
    this.control?.client.dispose();
    this.control = undefined;
  }

  private defaultModel(): SaveModelSettings {
    const model = this.options.settings.resolve();
    return { provider: model.provider, baseUrl: model.baseUrl, modelId: model.modelId, thinkingLevel: model.thinkingLevel };
  }

  private runtimeProfile(profile: ConversationExecutionProfile): RuntimeExecutionProfile {
    return {
      modelSettings: this.options.settings.resolve(profile),
      cwd: profile.cwd,
      resourceSelectionMode: profile.resourceSelectionMode,
      selectedSkills: [...profile.selectedSkills],
      selectedMcpServers: [...profile.selectedMcpServers],
    };
  }

  private conversationClient(conversationId: string, profile: ConversationExecutionProfile): ClientEntry {
    const existing = this.clients.get(conversationId);
    if (existing) return existing;
    this.pruneIdleClient();
    const entry: ClientEntry = { client: undefined as unknown as AgentRuntimeClient, lastUsed: Date.now() };
    entry.client = this.createClient(conversationId, entry, this.runtimeProfile(profile));
    this.clients.set(conversationId, entry);
    return entry;
  }

  private controlClient(): AgentRuntimeClient {
    if (!this.control) {
      const entry: ClientEntry = { client: undefined as unknown as AgentRuntimeClient, lastUsed: Date.now() };
      entry.client = this.createClient(controlConversationId, entry);
      this.control = entry;
    }
    this.control.lastUsed = Date.now();
    return this.control.client;
  }

  private createClient(conversationId: string, entry: ClientEntry, initialProfile?: RuntimeExecutionProfile): AgentRuntimeClient {
    return new AgentRuntimeClient({
      ...this.options,
      recoveryStore: this.recovery,
      initialProfile,
      getActiveProfile: () => entry.activeProfile,
      emit: (event) => this.options.emit(this.routeEvent(conversationId, event)),
    });
  }

  private routeEvent(conversationId: string, event: AgentEvent): AgentEvent {
    if (conversationId === controlConversationId || event.type === "conversation.updated") return event;
    if (event.type === "run.started") {
      if (event.conversationId !== conversationId) return { type: "run.error", conversationId, runId: event.runId, message: "Runtime 返回了不匹配的会话 ID，事件已隔离。" };
      return event;
    }
    return { ...event, conversationId } as AgentEvent;
  }

  private requireConversation(conversationId: string): AgentRuntimeClient {
    const client = this.clients.get(conversationId)?.client;
    if (!client) throw new Error("该会话当前没有运行中的 Agent Runtime。");
    return client;
  }

  private clientForRead(conversationId?: string): AgentRuntimeClient {
    return (conversationId ? this.clients.get(conversationId)?.client : undefined) ?? this.controlClient();
  }

  private async clientWithHistory(conversationId: string): Promise<AgentRuntimeClient> {
    const active = this.clients.get(conversationId)?.client;
    if (active) return active;
    const client = this.controlClient();
    await client.loadConversation(conversationId);
    return client;
  }

  private async stopAndRelease(conversationId: string): Promise<void> {
    const entry = this.clients.get(conversationId);
    if (!entry) return;
    if (entry.client.isRunning()) await entry.client.abort().catch(() => undefined);
    entry.client.dispose();
    this.clients.delete(conversationId);
  }

  private pruneIdleClient(): void {
    const limit = this.options.maxParallel ?? 3;
    if (this.clients.size < limit) return;
    const idle = [...this.clients.entries()].filter(([, entry]) => !entry.client.isRunning()).sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
    if (!idle) return;
    idle[1].client.dispose();
    this.clients.delete(idle[0]);
  }
}
