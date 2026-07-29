import {
  createAgentSession,
  createBashTool,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type CredentialStore, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CapabilitySettings,
  ConversationHistoryDetail,
  ConversationHistoryItem,
  PluginRuntimeStatus,
  PermissionRuntime,
  PermissionSettings,
  ModelCatalogEntry,
  PromptFileAttachment,
  PromptImage,
  ProviderCatalogEntry,
  QuestionOption,
  ResourceSettings,
  ResourceInventory,
  WorkspaceTrustStatus,
  SaveModelSettings,
  TaskFileChange,
  ToolActivityDetails,
} from "../src/contracts.js";
import { captureAgentSessionEvent } from "./agent-event-adapter.js";
import { decideToolPermission, type PermissionGrant } from "./permission-policy.js";
import { defaultPermissionSettings } from "./permission-store.js";
import type { ThinkingLevel } from "../src/contracts.js";
import { WorkspaceCommandSandbox } from "./workspace-command-sandbox.js";
import { mergeAnswerUsage } from "../src/response-usage.js";
import {
  buildProtocolModelMetadataIndex,
  matchProtocolModelMetadata,
  type ProtocolModelMetadata,
} from "./model-metadata-catalog.js";
import { ModelMetadataStore } from "./model-metadata-store.js";
import type { McpToolDescriptor } from "./mcp-service.js";
import type { BrowserDebugPort } from "./browser-service.js";
import { SubagentRunStore } from "./subagent-run-store.js";
import { errorMessage } from "./error-message.js";
import { FileChangeTracker, fileChangesEntryType } from "./file-changes.js";
import { ModelCatalog, compatibleProviderDefinitions, officialMetadataSources } from "./model-catalog.js";
import { ConversationHistory, initProjectPrompt, responseUsage } from "./conversation-history.js";
import { createDesktopResourceLoader } from "./resource-loader-factory.js";
import { CapabilityPolicy } from "./capability-policy.js";

type EventSink = (event: AgentEvent) => void;

type PendingQuestion = {
  resolve: (answer: string) => void;
};

export type AgentRuntimeConfig = {
  provider: string;
  baseUrl: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  apiKey?: string;
};

type ModelSettingsReader = {
  resolve(input?: SaveModelSettings): AgentRuntimeConfig;
};

type CapabilitySettingsReader = Pick<{ get(): CapabilitySettings }, "get">;
type PermissionSettingsReader = Pick<{ get(): PermissionSettings }, "get">;
type ResourceSettingsReader = Pick<{
  getSettings(): ResourceSettings;
  isProjectTrusted(cwd: string): boolean;
  getTrustStatus(cwd: string): WorkspaceTrustStatus;
}, "getSettings" | "isProjectTrusted" | "getTrustStatus">;
type PluginSecurityReader = Pick<{ isEnabled(source: string, cwd?: string): boolean }, "isEnabled">;
type McpRuntimePort = {
  tools(cwd?: string): Promise<McpToolDescriptor[]>;
  callTool(descriptor: McpToolDescriptor, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; details: unknown }>;
};

const builtinSubagentToolName = "pi_desktop_subagent";

function expandDesktopCommand(prompt: string): string {
  return prompt.trim() === "/init" ? initProjectPrompt : prompt;
}

export type PromptExtras = {
  images?: PromptImage[];
  attachments?: PromptFileAttachment[];
};

function sanitizeImages(images: PromptImage[] | undefined): ImageContent[] {
  return (images ?? [])
    .filter((image) => image && typeof image.data === "string" && typeof image.mimeType === "string" && image.data && image.mimeType)
    .map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

function sanitizeAttachments(attachments: PromptFileAttachment[] | undefined): PromptFileAttachment[] {
  return (attachments ?? []).filter((attachment) => attachment && typeof attachment.name === "string" && typeof attachment.content === "string");
}

// 文本附件以 <file> 块拼接到正文末尾；历史重建按同一格式解析，注意保持格式一致。
export function composePromptText(prompt: string, attachments?: PromptFileAttachment[]): string {
  const blocks = sanitizeAttachments(attachments)
    .map((attachment) => `\n\n<file name="${attachment.name.replace(/"/g, "")}">\n${attachment.content}\n</file>`)
    .join("");
  return `${prompt.trim()}${blocks}`;
}

const questionParameters = Type.Object({
  question: Type.String({ description: "A concise question for the user" }),
  options: Type.Optional(Type.Array(Type.Object({
    label: Type.String(),
    description: Type.Optional(Type.String()),
  }), { maxItems: 3 })),
});

const subagentParameters = Type.Object({
  role: Type.String({ description: "Short specialist role, for example code reviewer or debugger" }),
  task: Type.String({ description: "A self-contained task for the subagent" }),
});

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    const text = content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result ?? "");
  }
}

function resultDetails(result: unknown): ToolActivityDetails | undefined {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" ? details as ToolActivityDetails : undefined;
}

export class AgentService {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private sessionKey?: string;
  private activeRunId?: string;
  private pendingQuestions = new Map<string, PendingQuestion>();
  private running = false;
  private eventSequence = 0;
  private readonly runPermissionGrants = new Set<PermissionGrant>();
  private sessionDisplayContextWindow = 0;
  private subagentRunStore?: SubagentRunStore;
  private readonly fileChangeTracker: FileChangeTracker;
  private readonly modelCatalog: ModelCatalog;
  private readonly conversationHistory: ConversationHistory;
  private readonly capabilityPolicy: CapabilityPolicy;

  constructor(
    private readonly settings: ModelSettingsReader,
    private readonly agentDir: string,
    private readonly fallbackCwd: string,
    private readonly emit: EventSink,
    private readonly credentials: CredentialStore = new InMemoryCredentialStore(),
    private readonly capabilities: CapabilitySettingsReader = {
      get: () => ({
        subagent: { kind: "builtin" },
        memory: { kind: "none" },
        learning: { kind: "none" },
        subagentHistory: [],
        memoryHistory: [],
        learningHistory: [],
      }),
    },
    private readonly sessionDir: string = path.join(agentDir, "sessions"),
    private readonly permissions: PermissionSettingsReader = { get: () => defaultPermissionSettings },
    private readonly commandSandbox: WorkspaceCommandSandbox = new WorkspaceCommandSandbox(),
    private readonly modelMetadata: ModelMetadataStore = new ModelMetadataStore(path.dirname(agentDir)),
    private readonly resources: ResourceSettingsReader = {
      getSettings: () => ({ workspaceContextEnabled: true, disabledSkills: [] }),
      isProjectTrusted: () => false,
      getTrustStatus: (cwd) => ({ path: cwd, trusted: false, hasProjectResources: false, resourcePaths: [] }),
    },
    private readonly mcp?: McpRuntimePort,
    private readonly pluginSecurity?: PluginSecurityReader,
    private readonly browser?: BrowserDebugPort,
  ) {
    this.fileChangeTracker = new FileChangeTracker(this.emit, (runId) => this.persistFileChanges(runId));
    this.modelCatalog = new ModelCatalog(this.credentials, this.agentDir, this.modelMetadata);
    this.conversationHistory = new ConversationHistory(this.sessionDir, this.fallbackCwd, {
      isRunning: () => this.running,
      activeSession: () => this.session,
      disposeSession: () => this.disposeSession(),
      modelCatalog: this.modelCatalog,
      fileChangeTracker: this.fileChangeTracker,
      subagentRuns: () => this.subagentRuns(),
      subagentToolName: builtinSubagentToolName,
    });
    this.capabilityPolicy = new CapabilityPolicy(this.capabilities, this.pluginSecurity, builtinSubagentToolName);
  }

  async getModelCatalog(allowNetwork = true): Promise<ProviderCatalogEntry[]> {
    return this.modelCatalog.getModelCatalog(allowNetwork);
  }

  async discoverModels(input: SaveModelSettings): Promise<ModelCatalogEntry[]> {
    return this.modelCatalog.discoverModels(input);
  }

  async send(prompt: string, cwd?: string, conversationId?: string, extras?: PromptExtras): Promise<string> {
    if (this.running) throw new Error("Agent 正在执行，请先停止当前任务或等待完成。");
    const images = sanitizeImages(extras?.images);
    const attachments = sanitizeAttachments(extras?.attachments);
    if (!prompt.trim() && images.length === 0 && attachments.length === 0) throw new Error("消息不能为空。");

    const resolvedCwd = this.resolveCwd(cwd);
    const config = this.settings.resolve();
    await this.assertImagesSupported(config, images);
    const session = await this.ensureSession(resolvedCwd, config, conversationId);
    const runId = randomUUID();
    this.activeRunId = runId;
    this.running = true;
    this.eventSequence = 0;
    this.runPermissionGrants.clear();
    this.fileChangeTracker.setLastChangeRunId(runId);
    this.emit({ type: "changes.updated", runId, changes: [] });
    this.emit({
      type: "run.started",
      runId,
      conversationId: session.sessionManager.getSessionId(),
      provider: config.provider,
      model: config.modelId,
      cwd: resolvedCwd,
    });
    this.emitContextUsage(runId, session);

    void session.prompt(expandDesktopCommand(composePromptText(prompt, attachments)), images.length > 0 ? { images } : undefined).then(() => {
      if (this.activeRunId !== runId) return;
      const modelError = session.agent.state.errorMessage;
      this.persistFileChanges(runId);
      this.activeRunId = undefined;
      this.running = false;
      this.emitContextUsage(runId, session);
      if (modelError) this.emit({ type: "run.error", runId, message: modelError });
      else this.emit({ type: "run.completed", runId });
    }).catch((error: unknown) => {
      if (this.activeRunId === runId) {
        this.persistFileChanges(runId);
        this.activeRunId = undefined;
        this.running = false;
        this.emit({ type: "run.error", runId, message: errorMessage(error) });
      }
    });

    return runId;
  }

  async executeExtensionCommand(prompt: string, cwd?: string, conversationId?: string): Promise<boolean> {
    if (this.running) throw new Error("Agent 正在执行，请先停止当前任务或等待完成。");
    const normalized = prompt.trim();
    if (!normalized.startsWith("/")) return false;
    const commandName = normalized.slice(1).split(/\s/, 1)[0];
    const resolvedCwd = this.resolveCwd(cwd);
    const session = await this.ensureSession(resolvedCwd, this.settings.resolve(), conversationId);
    const exists = session.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has(commandName));
    if (!exists) return false;
    this.running = true;
    try {
      await session.prompt(normalized);
      return true;
    } finally {
      this.running = false;
    }
  }

  async listConversations(): Promise<ConversationHistoryItem[]> {
    return this.conversationHistory.listConversations();
  }

  async loadConversation(conversationId: string): Promise<ConversationHistoryDetail> {
    return this.conversationHistory.loadConversation(conversationId);
  }

  async forkConversation(conversationId: string, entryId?: string): Promise<ConversationHistoryItem> {
    return this.conversationHistory.forkConversation(conversationId, entryId);
  }

  async exportConversation(conversationId: string, format: "markdown" | "json"): Promise<{ filename: string; mimeType: "text/markdown" | "application/json"; content: string }> {
    return this.conversationHistory.exportConversation(conversationId, format);
  }

  async setConversationArchived(conversationId: string, archived: boolean): Promise<void> {
    return this.conversationHistory.setConversationArchived(conversationId, archived);
  }

  async setConversationTags(conversationId: string, tags: string[]): Promise<void> {
    return this.conversationHistory.setConversationTags(conversationId, tags);
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    return this.conversationHistory.renameConversation(conversationId, title);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    return this.conversationHistory.deleteConversation(conversationId);
  }

  async abort(): Promise<void> {
    const runId = this.activeRunId;
    for (const pending of this.pendingQuestions.values()) pending.resolve("用户取消了请求");
    this.pendingQuestions.clear();
    await this.session?.abort();
    if (runId && this.activeRunId === runId) {
      this.persistFileChanges(runId);
      this.emit({ type: "run.stopped", runId });
      this.activeRunId = undefined;
      this.running = false;
    }
  }

  async queueMessage(prompt: string, mode: "steer" | "followUp", extras?: PromptExtras): Promise<{ steering: string[]; followUp: string[] }> {
    if (!this.running || !this.session) throw new Error("当前没有正在运行的 Agent 任务。");
    const images = sanitizeImages(extras?.images);
    const attachments = sanitizeAttachments(extras?.attachments);
    if (!prompt.trim() && images.length === 0 && attachments.length === 0) throw new Error("排队消息不能为空。");
    await this.assertImagesSupported(this.settings.resolve(), images);
    const text = composePromptText(prompt, attachments);
    if (mode === "steer") await this.session.steer(text, images.length > 0 ? images : undefined);
    else await this.session.followUp(text, images.length > 0 ? images : undefined);
    return this.currentQueue();
  }

  // 仅在目录明确标记 supportsImages === false 时拦截；未知或查询失败不阻止发送。
  private async assertImagesSupported(config: AgentRuntimeConfig, images: ImageContent[]): Promise<void> {
    if (images.length === 0) return;
    let entry: ModelCatalogEntry | undefined;
    try {
      const catalog = await this.modelCatalog.getModelCatalog(false);
      entry = catalog.find((provider) => provider.id === config.provider)
        ?.models.find((model) => model.id === config.modelId);
    } catch {
      return;
    }
    if (entry?.supportsImages === false) throw new Error("当前模型不支持图片输入。");
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    if (!this.session) return { steering: [], followUp: [] };
    this.session.clearQueue();
    const queue = this.currentQueue();
    if (this.activeRunId) this.emit({ type: "queue.updated", runId: this.activeRunId, queue });
    return queue;
  }

  listChanges(runId?: string): TaskFileChange[] {
    return this.fileChangeTracker.listChanges(runId);
  }

  changePath(changeId: string): string {
    return this.fileChangeTracker.changePath(changeId);
  }

  acceptChanges(changeIds?: string[]): TaskFileChange[] {
    return this.fileChangeTracker.acceptChanges(changeIds);
  }

  revertChanges(changeIds?: string[]): TaskFileChange[] {
    return this.fileChangeTracker.revertChanges(changeIds);
  }

  private currentQueue(): { steering: string[]; followUp: string[] } {
    return {
      steering: [...(this.session?.getSteeringMessages() ?? [])],
      followUp: [...(this.session?.getFollowUpMessages() ?? [])],
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  getPermissionRuntime(): PermissionRuntime {
    return {
      ...this.permissions.get(),
      sandbox: this.commandSandbox.isAvailable() ? "available" : "unavailable",
      platform: process.platform,
    };
  }

  async getResourceInventory(cwd?: string): Promise<ResourceInventory> {
    const resolvedCwd = this.resolveCwd(cwd);
    const resourceSettings = this.resources.getSettings();
    const projectContextEnabled = resourceSettings.workspaceContextEnabled && this.resources.isProjectTrusted(resolvedCwd);
    const loader = createDesktopResourceLoader({
      cwd: resolvedCwd,
      agentDir: this.agentDir,
      projectContextEnabled,
      filterExtensions: (base, cwd) => this.capabilityPolicy.filterCapabilityExtensions(base, cwd),
      isPluginSourceEnabled: (source, cwd) => this.capabilityPolicy.isPluginSourceEnabled(source, cwd),
    });
    await loader.reload();
    const skillResult = loader.getSkills();
    const commands: ResourceInventory["commands"] = [];
    const commandNames = new Set<string>();
    for (const extension of loader.getExtensions().extensions) {
      for (const command of extension.commands.values()) {
        if (commandNames.has(command.name)) continue;
        commandNames.add(command.name);
        commands.push({
          name: `/${command.name}`,
          description: command.description ?? "Extension command",
          source: "extension",
          sourceLabel: command.sourceInfo.source,
        });
      }
    }
    for (const prompt of loader.getPrompts().prompts) {
      commands.push({
        name: `/${prompt.name}`,
        description: prompt.description,
        source: "prompt",
        sourceLabel: prompt.sourceInfo.source,
        argumentHint: prompt.argumentHint,
      });
    }
    for (const skill of skillResult.skills) {
      if (resourceSettings.disabledSkills.includes(skill.name)) continue;
      commands.push({
        name: `/skill:${skill.name}`,
        description: skill.description,
        source: "skill",
        sourceLabel: skill.sourceInfo.source,
      });
    }
    return {
      cwd: resolvedCwd,
      settings: resourceSettings,
      trust: this.resources.getTrustStatus(resolvedCwd),
      skills: skillResult.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        scope: skill.sourceInfo.scope,
        source: skill.sourceInfo.source,
        sourceKind: skill.sourceInfo.origin === "package" ? "package" : "local",
        enabled: !resourceSettings.disabledSkills.includes(skill.name),
        modelInvocable: !skill.disableModelInvocation,
      })),
      diagnostics: [
        ...skillResult.diagnostics,
        ...loader.getPrompts().diagnostics,
        ...loader.getExtensions().errors.map((error) => ({ type: "error" as const, message: error.error, path: error.path })),
      ].map((diagnostic) => ({ type: diagnostic.type, message: diagnostic.message, path: diagnostic.path })),
      commands: commands.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async reloadPackages(): Promise<boolean> {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再重新加载插件。");
    if (!this.session) return false;
    await this.session.reload();
    this.capabilityPolicy.applyToolPolicy(this.session);
    return true;
  }

  refreshCapabilities(): PluginRuntimeStatus {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再切换能力提供者。");
    if (this.session) this.capabilityPolicy.applyToolPolicy(this.session);
    return this.getPluginRuntime();
  }

  getPluginRuntime(): PluginRuntimeStatus {
    return this.capabilityPolicy.getPluginRuntime(this.session);
  }

  answerQuestion(callId: string, answer: string): void {
    const pending = this.pendingQuestions.get(callId);
    if (!pending) throw new Error("该问题已失效或已回答。");
    this.pendingQuestions.delete(callId);
    pending.resolve(answer.trim() || "用户未提供答案");
  }

  reset(): void {
    if (this.running) throw new Error("请先停止当前任务。");
    this.disposeSession();
  }

  async testConfiguration(input: SaveModelSettings): Promise<string> {
    const config = this.settings.resolve(input);
    const cwd = this.resolveCwd(undefined);
    const runtime = await this.createModelRuntime(config);
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      model: runtime.model,
      thinkingLevel: "off",
      modelRuntime: runtime.modelRuntime,
      noTools: "all",
      sessionManager: SessionManager.inMemory(cwd),
    });
    let response = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        response += event.assistantMessageEvent.delta;
      }
    });
    try {
      await session.prompt("Reply with exactly: PI_CONNECTION_OK");
      if (session.agent.state.errorMessage) throw new Error(session.agent.state.errorMessage);
      const text = response.trim();
      if (!text) throw new Error("模型连接成功，但没有返回可显示的文本。");
      return text;
    } finally {
      unsubscribe();
      session.dispose();
    }
  }

  dispose(): void {
    this.disposeSession();
    void this.commandSandbox.reset();
  }

  private async sessionManager(cwd: string, conversationId?: string): Promise<SessionManager> {
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    if (conversationId) {
      const existing = (await SessionManager.list(cwd, this.sessionDir)).find((session) => session.id === conversationId);
      if (existing) return SessionManager.open(existing.path, this.sessionDir, cwd);
      return SessionManager.create(cwd, this.sessionDir, { id: conversationId });
    }
    return SessionManager.create(cwd, this.sessionDir);
  }

  private async ensureSession(cwd: string, config: AgentRuntimeConfig, conversationId?: string): Promise<AgentSession> {
    const key = JSON.stringify([cwd, conversationId, config.provider, config.baseUrl, config.modelId, config.thinkingLevel, config.apiKey]);
    if (this.session && this.sessionKey === key) return this.session;
    this.disposeSession();

    const runtime = await this.createModelRuntime(config);
    const resourceSettings = this.resources.getSettings();
    const projectContextEnabled = resourceSettings.workspaceContextEnabled && this.resources.isProjectTrusted(cwd);
    const resourceLoader = createDesktopResourceLoader({
      cwd,
      agentDir: this.agentDir,
      projectContextEnabled,
      disabledSkills: resourceSettings.disabledSkills,
      extensionFactories: [
        (pi) => {
          const sandboxedBash = createBashTool(cwd, { operations: this.commandSandbox.createOperations() });
          pi.registerTool({ ...sandboxedBash, label: "bash (workspace sandbox)" });
          pi.on("tool_call", async (event) => {
            if (!this.activeRunId) return undefined;
            const input = event.input as Record<string, unknown>;
            const mode = this.permissions.get().mode;
            const sandboxAvailable = event.toolName === "bash" && mode === "balanced" && this.capabilityPolicy.sandboxedBashActive
              ? await this.commandSandbox.prepare(cwd)
              : false;
            const decision = decideToolPermission({
              toolName: event.toolName,
              input,
              cwd,
              mode,
              sandboxAvailable,
              runGrants: this.runPermissionGrants,
            });
            if (decision.action === "allow") return undefined;
            const summary = resultText(event.input);
            const options: QuestionOption[] = [
              { label: "允许一次", description: "仅允许当前这次工具调用" },
            ];
            if (decision.allowForRun) {
              options.push({ label: "允许本次任务", description: "本次回复中不再询问同类操作" });
            }
            options.push({ label: "拒绝", description: "阻止本次调用并让 Agent 调整方案" });
            const answer = await this.requestUser(
              event.toolCallId,
              `${decision.reason}\n\n${summary}`,
              options,
            );
            if (answer === "允许本次任务" && decision.allowForRun) {
              this.runPermissionGrants.add(decision.allowForRun);
              return undefined;
            }
            return answer === "允许一次" ? undefined : { block: true, reason: "用户拒绝了本次工具调用" };
          });
        },
      ],
      filterExtensions: (base, targetCwd) => this.capabilityPolicy.filterCapabilityExtensions(base, targetCwd),
      isPluginSourceEnabled: (source, targetCwd) => this.capabilityPolicy.isPluginSourceEnabled(source, targetCwd),
    });
    await resourceLoader.reload();

    const customTools = await this.createCustomTools(cwd, runtime);
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      model: runtime.model,
      thinkingLevel: config.thinkingLevel,
      modelRuntime: runtime.modelRuntime,
      resourceLoader,
      customTools,
      sessionManager: await this.sessionManager(cwd, conversationId),
    });

    this.capabilityPolicy.applyToolPolicy(session);
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
    this.session = session;
    this.sessionKey = key;
    this.fileChangeTracker.setSessionCwd(cwd);
    this.sessionDisplayContextWindow = runtime.displayContextWindow;
    return session;
  }

  private async createCustomTools(
    cwd: string,
    runtime: Awaited<ReturnType<AgentService["createModelRuntime"]>>,
  ): Promise<ToolDefinition[]> {
    const askUser = defineTool({
      name: "ask_user",
      label: "Ask user",
      description: "Ask the user for missing information or a decision and wait for their answer.",
      promptSnippet: "Ask the user a focused question when their decision is required",
      promptGuidelines: ["Use ask_user only when the answer materially changes the work and cannot be inferred safely."],
      parameters: questionParameters,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal) => {
        const answer = await this.requestUser(toolCallId, params.question, params.options ?? [], signal);
        return {
          content: [{ type: "text", text: `User answered: ${answer}` }],
          details: { question: params.question, answer },
        };
      },
    });

    const spawnSubagent = defineTool({
      name: builtinSubagentToolName,
      label: "Spawn subagent",
      description: "Delegate one focused, self-contained research, review, or implementation task to a subagent.",
      promptSnippet: "Delegate independent focused work to a subagent",
      promptGuidelines: ["Give each subagent a bounded task and use its returned findings in your response."],
      parameters: subagentParameters,
      executionMode: "parallel",
      execute: async (toolCallId, params, signal, onUpdate) => {
        const childLoader = createDesktopResourceLoader({
          cwd,
          agentDir: this.agentDir,
          projectContextEnabled: this.resources.isProjectTrusted(cwd),
          extensionFactories: [(pi) => {
            pi.on("tool_call", (event) => {
              const input = event.input as Record<string, unknown>;
              const decision = decideToolPermission({
                toolName: event.toolName,
                input,
                cwd,
                mode: "balanced",
                sandboxAvailable: false,
                runGrants: new Set(),
              });
              if (decision.kind === "outside-workspace") {
                return { block: true, reason: "子 Agent 不允许访问工作目录之外的路径" };
              }
              return undefined;
            });
          }],
          filterExtensions: (base, targetCwd) => this.capabilityPolicy.filterCapabilityExtensions(base, targetCwd),
          isPluginSourceEnabled: (source, targetCwd) => this.capabilityPolicy.isPluginSourceEnabled(source, targetCwd),
        });
        await childLoader.reload();
        const subagentSessionDir = path.join(this.sessionDir, "subagents");
        fs.mkdirSync(subagentSessionDir, { recursive: true, mode: 0o700 });
        const childManager = SessionManager.create(cwd, subagentSessionDir);
        const store = this.subagentRuns();
        let record = store.create({
          parentRunId: this.activeRunId,
          parentConversationId: this.session?.sessionManager.getSessionId(),
          toolCallId,
          role: params.role,
          task: params.task,
          cwd,
          sessionId: childManager.getSessionId(),
        });
        let child: Awaited<ReturnType<typeof createAgentSession>> | undefined;
        let output = "";
        let activity = `子 Agent（${params.role}）已启动…`;
        let unsubscribe: (() => void) | undefined;
        const abortChild = () => void child?.session.abort();
        try {
          const createdChild = await createAgentSession({
            cwd,
            agentDir: this.agentDir,
            model: runtime.model,
            thinkingLevel: runtime.thinkingLevel,
            modelRuntime: runtime.modelRuntime,
            resourceLoader: childLoader,
            tools: ["read", "grep", "find", "ls"],
            sessionManager: childManager,
          });
          child = createdChild;
          unsubscribe = createdChild.session.subscribe((event) => {
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
              output += event.assistantMessageEvent.delta;
              activity = output;
            } else if (event.type === "tool_execution_start") {
              activity = `${output}\n\n正在调用 ${event.toolName}…`.trim();
            } else if (event.type === "message_end" && event.message.role === "assistant") {
              record = store.update(record.id, { usage: mergeAnswerUsage(record.usage, responseUsage(event.message)) }) ?? record;
            }
            onUpdate?.({
              content: [{ type: "text", text: activity }],
              details: { subagent: record },
            });
          });
          signal?.addEventListener("abort", abortChild, { once: true });
          if (signal?.aborted) abortChild();
          await createdChild.session.prompt(`You are the ${params.role} subagent. Complete this bounded task and return concise, evidence-based findings to the parent agent.\n\n${params.task}`);
          if (signal?.aborted) throw new Error("Subagent was stopped by the user.");
          if (createdChild.session.agent.state.errorMessage) throw new Error(createdChild.session.agent.state.errorMessage);
          const completedAt = new Date().toISOString();
          record = store.update(record.id, { status: "completed", completedAt }) ?? record;
          return {
            content: [{ type: "text", text: output.trim() || "Subagent completed without text output." }],
            details: { subagent: record },
          };
        } catch (error) {
          const completedAt = new Date().toISOString();
          record = store.update(record.id, {
            status: signal?.aborted ? "stopped" : "error",
            completedAt,
            error: errorMessage(error),
          }) ?? record;
          onUpdate?.({ content: [{ type: "text", text: activity }], details: { subagent: record } });
          throw error;
        } finally {
          signal?.removeEventListener("abort", abortChild);
          unsubscribe?.();
          child?.session.dispose();
        }
      },
    });

    const browserAnnotate = this.browser ? defineTool({
      name: "browser_annotate",
      label: "Visual browser annotation",
      description:
        "Open Pi Desktop's built-in browser annotation mode and wait for the user to select UI elements. "
        + "Returns selectors, DOM attributes, accessibility data, computed styles, comments, and a screenshot path. "
        + "Use when the user asks to visually debug, inspect, annotate, or point out a frontend issue.",
      promptSnippet: "Let the user visually annotate a page in Pi Desktop's built-in browser",
      promptGuidelines: [
        "Use browser_annotate only for explicit visual debugging or annotation requests.",
        "After it returns, inspect the screenshot path with the read tool when visual evidence is useful.",
      ],
      parameters: Type.Object({
        url: Type.Optional(Type.String({ description: "HTTP(S) URL to open before annotation. Omit to use the current built-in browser page." })),
        prompt: Type.Optional(Type.String({ description: "Short context shown in the annotation panel." })),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        const capture = await this.browser!.startAnnotation(params.url, params.prompt ?? "", signal);
        return {
          content: [{ type: "text", text: capture.markdown }],
          details: capture.result,
        };
      },
    }) : undefined;

    const mcpTools = this.mcp ? await this.mcp.tools(cwd) : [];
    const adaptedMcpTools = mcpTools.map((descriptor) => defineTool({
      name: descriptor.name,
      label: `MCP · ${descriptor.remoteName}`,
      description: descriptor.description,
      promptSnippet: `Call ${descriptor.remoteName} on its configured MCP Server`,
      promptGuidelines: ["Use MCP tools only when their external capability is needed and send the minimum necessary data."],
      parameters: descriptor.inputSchema as TSchema,
      executionMode: "parallel",
      execute: async (_toolCallId, params, signal) => {
        if (!this.mcp) throw new Error("MCP 服务不可用。");
        const result = await this.mcp.callTool(descriptor, params as Record<string, unknown>, signal);
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      },
    }));

    return [askUser, spawnSubagent, ...(browserAnnotate ? [browserAnnotate] : []), ...adaptedMcpTools];
  }

  private async createModelRuntime(config: AgentRuntimeConfig) {
    const modelRuntime = await ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: path.join(this.agentDir, "models.json"),
      modelsStorePath: path.join(this.agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const compatible = compatibleProviderDefinitions[config.provider];
    const protocolMetadata = buildProtocolModelMetadataIndex(modelRuntime.getProviders().flatMap((provider) => (
      provider.getModels().map((entry) => ({
        id: entry.id,
        name: entry.name,
        reasoning: entry.reasoning,
        protocol: entry.api,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxTokens,
        pricing: { ...entry.cost },
        metadataSourceUrl: officialMetadataSources[provider.id],
      }))
    )));
    let matchedMetadata: ProtocolModelMetadata | undefined;

    if (compatible) {
      const endpoint = new URL(config.baseUrl);
      const isLocal = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
      const apiKey = config.apiKey || (isLocal ? "local" : undefined);
      if (apiKey) await modelRuntime.setRuntimeApiKey(config.provider, apiKey, { allowNetwork: false });
      const discoveredModel = this.modelCatalog.readDiscoveredModels()[config.provider]?.models.find((model) => model.id === config.modelId);
      matchedMetadata = matchProtocolModelMetadata(protocolMetadata, compatible.api, config.modelId);
      const displayContextWindow = discoveredModel?.contextWindow || matchedMetadata?.contextWindow || 0;
      modelRuntime.registerProvider(config.provider, {
        name: compatible.name,
        baseUrl: config.baseUrl,
        api: compatible.api,
        authHeader: compatible.authHeader,
        models: [{
          id: config.modelId,
          name: config.modelId,
          api: compatible.api,
          reasoning: true,
          input: ["text", "image"],
          cost: matchedMetadata?.pricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // The SDK requires a positive runtime limit. Keep the conservative
          // fallback internal; the UI only exposes displayContextWindow when
          // the endpoint or authoritative metadata supplied one.
          contextWindow: displayContextWindow || 128_000,
          maxTokens: matchedMetadata?.maxOutputTokens || 32_000,
          compat: compatible.api === "openai-completions" ? {
            supportsDeveloperRole: false,
            supportsReasoningEffort: config.thinkingLevel !== "off",
          } : undefined,
        }],
      });
    } else {
      const provider = modelRuntime.getProvider(config.provider);
      if (!provider) throw new Error(`Pi SDK 中不存在 provider：${config.provider}。`);
      if (config.apiKey) {
        await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey, { allowNetwork: false });
      }
      if (config.baseUrl && config.baseUrl !== provider.baseUrl) {
        modelRuntime.registerProvider(config.provider, { baseUrl: config.baseUrl });
      }
    }

    const model = modelRuntime.getModel(config.provider, config.modelId) as Model<Api> | undefined;
    if (!model) throw new Error(`在 ${config.provider} 的 Pi 模型目录中找不到 ${config.modelId}。`);
    const auth = await modelRuntime.getAuth(model);
    if (!auth) {
      const provider = modelRuntime.getProvider(config.provider);
      const loginHint = provider?.auth.oauth && !provider.auth.apiKey
        ? "该 Provider 需要 OAuth/订阅登录，请先在设置中完成登录。"
        : "请保存 API Key，或在启动 Pi Desktop 前配置该 provider 所需的环境凭据。";
      throw new Error(`尚未配置 ${provider?.name ?? config.provider} 的凭据。${loginHint}`);
    }
    const metadataOverride = this.modelMetadata.get(config.provider, config.modelId);
    const effectiveModel: Model<Api> = metadataOverride ? {
      ...model,
      name: metadataOverride.name,
      contextWindow: metadataOverride.contextWindow || model.contextWindow,
      maxTokens: metadataOverride.maxOutputTokens || model.maxTokens,
      cost: { ...metadataOverride.pricing },
    } : model;
    return {
      modelRuntime,
      model: effectiveModel,
      thinkingLevel: config.thinkingLevel,
      displayContextWindow: metadataOverride?.contextWindow || (compatible
        ? this.modelCatalog.readDiscoveredModels()[config.provider]?.models.find((entry) => entry.id === config.modelId)?.contextWindow
          || matchedMetadata?.contextWindow
          || 0
        : model.contextWindow),
    };
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const runId = this.activeRunId;
    if (!runId) return;
    this.eventSequence += 1;
    this.emit({ type: "agent.event", runId, event: captureAgentSessionEvent(event, this.eventSequence) });
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        this.emit({ type: "message.delta", runId, text: event.assistantMessageEvent.delta });
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        this.emit({ type: "thinking.delta", runId, text: event.assistantMessageEvent.delta });
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.emit({ type: "response.usage", runId, usage: responseUsage(event.message) });
      this.emitContextUsage(runId);
    } else if (event.type === "compaction_end") {
      this.emitContextUsage(runId);
    } else if (event.type === "queue_update") {
      this.emit({ type: "queue.updated", runId, queue: { steering: [...event.steering], followUp: [...event.followUp] } });
    } else if (event.type === "tool_execution_start") {
      this.fileChangeTracker.captureFileMutationStart(event.toolCallId, event.toolName, event.args);
      this.emit({ type: "tool.started", runId, callId: event.toolCallId, name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_update") {
      this.emit({ type: "tool.updated", runId, callId: event.toolCallId, name: event.toolName, output: resultText(event.partialResult), details: resultDetails(event.partialResult) });
    } else if (event.type === "tool_execution_end") {
      this.fileChangeTracker.captureFileMutationEnd(runId, event.toolCallId, event.toolName, event.result, event.isError);
      this.emit({
        type: "tool.completed",
        runId,
        callId: event.toolCallId,
        name: event.toolName,
        output: resultText(event.result),
        isError: event.isError,
        details: resultDetails(event.result),
      });
    }
  }

  private subagentRuns(): SubagentRunStore {
    return this.subagentRunStore ??= new SubagentRunStore(path.join(this.sessionDir, "subagents"));
  }

  private persistFileChanges(runId: string): void {
    if (!this.session) return;
    const changes = this.fileChangeTracker.listChanges(runId);
    if (changes.length === 0) return;
    this.session.sessionManager.appendCustomEntry(fileChangesEntryType, { runId, changes });
  }

  private emitContextUsage(runId: string, session: AgentSession | undefined = this.session): void {
    const usage = session?.getContextUsage();
    if (usage && this.sessionDisplayContextWindow > 0) {
      this.emit({
        type: "context.updated",
        runId,
        usage: {
          tokens: usage.tokens,
          contextWindow: this.sessionDisplayContextWindow,
          percent: usage.tokens === null ? null : (usage.tokens / this.sessionDisplayContextWindow) * 100,
        },
      });
    }
  }

  private requestUser(callId: string, question: string, options: QuestionOption[], signal?: AbortSignal): Promise<string> {
    const runId = this.activeRunId;
    if (!runId) return Promise.resolve("No active user session");
    return new Promise((resolve) => {
      const finish = (answer: string) => {
        signal?.removeEventListener("abort", cancel);
        resolve(answer);
      };
      const cancel = () => {
        this.pendingQuestions.delete(callId);
        finish("用户取消了请求");
      };
      this.pendingQuestions.set(callId, { resolve: finish });
      signal?.addEventListener("abort", cancel, { once: true });
      this.emit({ type: "question.requested", runId, callId, question, options });
    });
  }

  private resolveCwd(candidate?: string): string {
    if (candidate) {
      const resolved = path.resolve(candidate);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("所选工作目录不存在。");
      return resolved;
    }
    fs.mkdirSync(this.fallbackCwd, { recursive: true, mode: 0o700 });
    return this.fallbackCwd;
  }

  private disposeSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.sessionKey = undefined;
    this.fileChangeTracker.setSessionCwd(undefined);
    this.fileChangeTracker.clearPendingMutations();
    this.sessionDisplayContextWindow = 0;
    this.capabilityPolicy.sandboxedBashActive = false;
    this.activeRunId = undefined;
    this.running = false;
    for (const pending of this.pendingQuestions.values()) pending.resolve("会话已结束");
    this.pendingQuestions.clear();
  }
}
