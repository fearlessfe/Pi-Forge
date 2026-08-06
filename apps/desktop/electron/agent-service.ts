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
import { InMemoryCredentialStore, parseStreamingJson, type Api, type CredentialStore, type ImageContent, type Model } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  ConversationHistoryDetail,
  ConversationHistoryItem,
  ConversationHistoryPage,
  ConversationListQuery,
  EnqueueSubagentInput,
  PlanReviewArtifact,
  PromptFileAttachment,
  PromptImage,
  QuestionOption,
  ResolvePlanReviewInput,
  ResponseUsage,
  BackgroundSubagentRunInfo as SubagentRunInfo,
  TaskFileChange,
  ToolActivityDetails,
} from "@pi-forge/runtime-contracts";
import { Type, type TSchema } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CapabilitySettings,
  ContextBudgetReport,
  PluginRuntimeStatus,
  PermissionRuntime,
  PermissionSettings,
  ProjectResourceSettings,
  ModelCatalogEntry,
  ProviderCatalogEntry,
  ResourceSettings,
  ResourceInventory,
  WorkspaceTrustStatus,
  SaveModelSettings,
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
import type { McpContextResource, McpToolDescriptor } from "./mcp-service.js";
import type { BrowserDebugPort } from "./browser-service.js";
import { SubagentRunStore } from "./subagent-run-store.js";
import { SubagentScheduler, type SubagentExecutionResult } from "./subagent-scheduler.js";
import { errorMessage } from "./error-message.js";
import { FileChangeTracker, fileChangesEntryType } from "./file-changes.js";
import { ModelCatalog, compatibleProviderDefinitions, officialMetadataSources } from "./model-catalog.js";
import { ConversationHistory, initProjectPrompt, responseUsage } from "./conversation-history.js";
import { createDesktopResourceLoader } from "./resource-loader-factory.js";
import { CapabilityPolicy } from "./capability-policy.js";
import {
  AttachmentStore,
  defaultAttachmentReadBytes,
  maxAttachmentReadBytes,
  type PreparedAttachment,
} from "./attachment-store.js";
import { validatePromptExtras } from "./ipc-input-validation.js";
import {
  buildContextBudgetReport,
  createContextTokenEstimator,
  stableContextValue,
  type ContextBudgetResource,
} from "./context-budget.js";
import { ContextBudgetHistoryStore } from "./context-budget-history-store.js";
import { PlanReviewStore } from "./plan-review-store.js";

type EventSink = (event: AgentEvent) => void;

type PendingQuestion = {
  resolve: (answer: string) => void;
};

type PendingPlanReview = {
  resolve: (review: PlanReviewArtifact) => void;
  reject: (error: Error) => void;
};

type StreamingPlanDraft = {
  toolCallId: string;
  json: string;
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
type ResourceSettingsReader = {
  getSettings(): ResourceSettings;
  getProjectSettings?(cwd: string): ProjectResourceSettings;
  isProjectTrusted(cwd: string): boolean;
  isKnownWorkspace?(cwd: string): boolean;
  getTrustStatus(cwd: string): WorkspaceTrustStatus;
};
type PluginSecurityReader = Pick<{ isEnabled(source: string, cwd?: string): boolean }, "isEnabled">;
type McpRuntimePort = {
  tools(cwd?: string): Promise<McpToolDescriptor[]>;
  contextInventory(cwd?: string): Promise<McpContextResource[]>;
  callTool(descriptor: McpToolDescriptor, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; details: unknown }>;
};
type SubagentQueuePort = {
  enqueue(input: Pick<EnqueueSubagentInput, "toolCallId" | "role" | "task">): Promise<SubagentRunInfo>;
};

const builtinSubagentToolName = "pi_desktop_subagent";

function expandDesktopCommand(prompt: string): string {
  return prompt.trim() === "/init" ? initProjectPrompt : prompt;
}

export type PromptExtras = {
  images?: PromptImage[];
  attachments?: PromptFileAttachment[];
};

function runtimePromptExtras(extras: PromptExtras | undefined): {
  images: ImageContent[];
  attachments: PromptFileAttachment[];
} {
  const validated = validatePromptExtras(extras ?? {});
  return {
    images: (validated.images ?? []).map((image) => ({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    })),
    attachments: validated.attachments ?? [],
  };
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 小文件保留正文内容，大文件只注入不可猜测的 capability ID，由 read_attachment 分块读取。
export function composePromptText(prompt: string, attachments?: PreparedAttachment[]): string {
  const blocks = (attachments ?? [])
    .map((attachment) => {
      const attributes = `attachment-id="${attachment.id}" name="${escapeXmlAttribute(attachment.name)}" mime-type="${escapeXmlAttribute(attachment.mimeType)}" size="${attachment.size}"`;
      return attachment.access === "inline"
        ? `\n\n<file ${attributes} access="inline">\n${attachment.content}\n</file>`
        : `\n\n<attachment ${attributes} access="read_attachment" />`;
    })
    .join("");
  return `${prompt.trim()}${blocks}`;
}

function attachmentIdsInMessages(messages: AgentSession["messages"]): Set<string> {
  const ids = new Set<string>();
  const pattern = /\battachment-id="([0-9a-f-]{36})"/gi;
  for (const message of messages) {
    if (!("content" in message)) continue;
    const text = messageContentText(message.content);
    for (const match of text.matchAll(pattern)) ids.add(match[1]);
  }
  return ids;
}

const questionParameters = Type.Object({
  question: Type.String({ description: "A concise question for the user" }),
  options: Type.Optional(Type.Array(Type.Object({
    label: Type.String(),
    description: Type.Optional(Type.String()),
  }), { maxItems: 3 })),
});

const planReviewParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, description: "Short title for the plan" }),
  markdown: Type.String({ minLength: 1, maxLength: 200_000, description: "Complete Markdown plan for explicit user review" }),
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

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
}

function activeToolSchemas(session: AgentSession): { text: string; count: number } {
  const schemas = session.getActiveToolNames().flatMap((name) => {
    const definition = session.getToolDefinition(name);
    return definition ? [{
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }] : [];
  });
  return {
    text: schemas.length > 0 ? stableContextValue(schemas) : "",
    count: schemas.length,
  };
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
  private activeCwd?: string;
  private activeRunId?: string;
  private pendingQuestions = new Map<string, PendingQuestion>();
  private pendingPlanReviews = new Map<string, PendingPlanReview>();
  private streamingPlanDrafts = new Map<number, StreamingPlanDraft>();
  private running = false;
  private eventSequence = 0;
  private readonly runPermissionGrants = new Set<PermissionGrant>();
  private sessionDisplayContextWindow = 0;
  private subagentRunStore?: SubagentRunStore;
  private subagentScheduler?: SubagentScheduler;
  private readonly fileChangeTracker: FileChangeTracker;
  private readonly modelCatalog: ModelCatalog;
  private readonly conversationHistory: ConversationHistory;
  private readonly capabilityPolicy: CapabilityPolicy;
  private readonly attachmentStore: AttachmentStore;
  private readonly contextBudgetHistory: ContextBudgetHistoryStore;
  private readonly planReviews: PlanReviewStore;

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
    private readonly subagentQueue?: SubagentQueuePort,
    manageBackgroundSubagents = false,
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
    this.attachmentStore = new AttachmentStore(this.sessionDir);
    this.contextBudgetHistory = new ContextBudgetHistoryStore(this.agentDir);
    this.planReviews = new PlanReviewStore(this.agentDir);
    if (manageBackgroundSubagents) {
      this.subagentScheduler = new SubagentScheduler(this.subagentRuns(), (run, signal, onUpdate) => (
        this.executeBackgroundSubagent(run, signal, onUpdate)
      ));
      this.subagentScheduler.subscribe(({ run }) => this.emit({
        type: "tool.updated",
        runId: run.parentRunId ?? run.id,
        conversationId: run.parentConversationId,
        callId: run.toolCallId,
        name: builtinSubagentToolName,
        output: run.result ?? run.error ?? run.status,
        details: { backgroundSubagent: run },
      }));
    }
  }

  async getModelCatalog(allowNetwork = true): Promise<ProviderCatalogEntry[]> {
    return this.modelCatalog.getModelCatalog(allowNetwork);
  }

  async discoverModels(input: SaveModelSettings): Promise<ModelCatalogEntry[]> {
    return this.modelCatalog.discoverModels(input);
  }

  async send(prompt: string, cwd?: string, conversationId?: string, extras?: PromptExtras): Promise<string> {
    if (this.running) throw new Error("Agent 正在执行，请先停止当前任务或等待完成。");
    const { images, attachments } = runtimePromptExtras(extras);
    if (!prompt.trim() && images.length === 0 && attachments.length === 0) throw new Error("消息不能为空。");

    const resolvedCwd = this.resolveCwd(cwd);
    const config = this.settings.resolve();
    await this.assertImagesSupported(config, images);
    const session = await this.ensureSession(resolvedCwd, config, conversationId);
    const preparedAttachments = this.attachmentStore.create(session.sessionManager.getSessionId(), attachments);
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

    void session.prompt(expandDesktopCommand(composePromptText(prompt, preparedAttachments)), images.length > 0 ? { images } : undefined).then(async () => {
      if (this.activeRunId !== runId) return;
      const modelError = session.agent.state.errorMessage;
      this.persistFileChanges(runId);
      this.activeRunId = undefined;
      this.running = false;
      this.emitContextUsage(runId, session);
      await this.emitConversationUpsert(session.sessionManager.getSessionId(), modelError ? "run-error" : "run-completed");
      if (modelError) this.emit({ type: "run.error", runId, message: modelError });
      else this.emit({ type: "run.completed", runId });
    }).catch(async (error: unknown) => {
      if (this.activeRunId === runId) {
        this.persistFileChanges(runId);
        this.activeRunId = undefined;
        this.running = false;
        await this.emitConversationUpsert(session.sessionManager.getSessionId(), "run-error");
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

  async listConversationPage(query?: ConversationListQuery): Promise<ConversationHistoryPage> {
    return this.conversationHistory.listConversationPage(query);
  }

  async loadConversation(conversationId: string): Promise<ConversationHistoryDetail> {
    return this.conversationHistory.loadConversation(conversationId);
  }

  async forkConversation(conversationId: string, entryId?: string): Promise<ConversationHistoryItem> {
    const conversation = await this.conversationHistory.forkConversation(conversationId, entryId);
    this.emit({ type: "conversation.updated", kind: "upsert", reason: "forked", conversation });
    return conversation;
  }

  async exportConversation(conversationId: string, format: "markdown" | "json"): Promise<{ filename: string; mimeType: "text/markdown" | "application/json"; content: string }> {
    return this.conversationHistory.exportConversation(conversationId, format);
  }

  async setConversationArchived(conversationId: string, archived: boolean): Promise<void> {
    await this.conversationHistory.setConversationArchived(conversationId, archived);
    await this.emitConversationUpsert(conversationId, "archive-changed");
  }

  async setConversationTags(conversationId: string, tags: string[]): Promise<void> {
    await this.conversationHistory.setConversationTags(conversationId, tags);
    await this.emitConversationUpsert(conversationId, "tags-changed");
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    await this.conversationHistory.renameConversation(conversationId, title);
    await this.emitConversationUpsert(conversationId, "renamed");
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.conversationHistory.deleteConversation(conversationId);
    this.emit({ type: "conversation.updated", kind: "delete", reason: "deleted", conversationId });
  }

  async abort(): Promise<void> {
    const runId = this.activeRunId;
    for (const pending of this.pendingQuestions.values()) pending.resolve("用户取消了请求");
    this.pendingQuestions.clear();
    await this.session?.abort();
    if (runId && this.activeRunId === runId) {
      this.persistFileChanges(runId);
      const conversationId = this.session?.sessionManager.getSessionId();
      this.activeRunId = undefined;
      this.running = false;
      if (conversationId) await this.emitConversationUpsert(conversationId, "run-stopped");
      this.emit({ type: "run.stopped", runId });
    }
  }

  async queueMessage(prompt: string, mode: "steer" | "followUp", extras?: PromptExtras): Promise<{ steering: string[]; followUp: string[] }> {
    if (!this.running || !this.session) throw new Error("当前没有正在运行的 Agent 任务。");
    const { images, attachments } = runtimePromptExtras(extras);
    if (!prompt.trim() && images.length === 0 && attachments.length === 0) throw new Error("排队消息不能为空。");
    await this.assertImagesSupported(this.settings.resolve(), images);
    const preparedAttachments = this.attachmentStore.create(this.session.sessionManager.getSessionId(), attachments);
    const text = composePromptText(prompt, preparedAttachments);
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
    const projectSettings = this.projectResourceSettings(resolvedCwd);
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
      if (!this.isSkillEnabled(skill.name, projectSettings, resourceSettings)) continue;
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
      projectSettings,
      trust: this.resources.getTrustStatus(resolvedCwd),
      skills: skillResult.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        scope: skill.sourceInfo.scope,
        source: skill.sourceInfo.source,
        sourceKind: skill.sourceInfo.origin === "package" ? "package" : "local",
        enabled: this.isSkillEnabled(skill.name, projectSettings, resourceSettings),
        globalEnabled: !resourceSettings.disabledSkills.includes(skill.name),
        projectEnabled: this.isProjectSkillEnabled(skill.name, projectSettings),
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

  async getContextBudget(cwd?: string): Promise<ContextBudgetReport> {
    const resolvedCwd = this.resolveCwd(cwd);
    const resourceSettings = this.resources.getSettings();
    const projectSettings = this.projectResourceSettings(resolvedCwd);
    const projectContextEnabled = resourceSettings.workspaceContextEnabled && this.resources.isProjectTrusted(resolvedCwd);
    const loader = createDesktopResourceLoader({
      cwd: resolvedCwd,
      agentDir: this.agentDir,
      projectContextEnabled,
      filterExtensions: (base, targetCwd) => this.capabilityPolicy.filterCapabilityExtensions(base, targetCwd),
      isPluginSourceEnabled: (source, targetCwd) => this.capabilityPolicy.isPluginSourceEnabled(source, targetCwd),
    });
    await loader.reload();

    const budgetResources: ContextBudgetResource[] = [];
    const systemPrompt = loader.getSystemPrompt();
    if (systemPrompt) {
      const scope = projectContextEnabled && fs.existsSync(path.join(resolvedCwd, ".pi", "SYSTEM.md")) ? "project" : "user";
      budgetResources.push({
        category: "systemPrompt",
        name: "SYSTEM.md",
        source: "agent",
        scope,
        enabled: true,
        disableSupported: false,
        baselineText: systemPrompt,
      });
    }
    loader.getAppendSystemPrompt().forEach((content, index) => {
      const scope = projectContextEnabled && fs.existsSync(path.join(resolvedCwd, ".pi", "APPEND_SYSTEM.md")) ? "project" : "user";
      budgetResources.push({
        category: "systemPrompt",
        name: index === 0 ? "APPEND_SYSTEM.md" : `APPEND_SYSTEM.md ${index + 1}`,
        source: "agent",
        scope,
        enabled: true,
        disableSupported: false,
        baselineText: content,
      });
    });

    for (const agentsFile of loader.getAgentsFiles().agentsFiles) {
      const scope = path.resolve(agentsFile.path).startsWith(`${path.resolve(this.agentDir)}${path.sep}`) ? "user" : "project";
      budgetResources.push({
        category: "agents",
        name: path.basename(agentsFile.path),
        source: scope,
        scope,
        enabled: true,
        disableSupported: false,
        baselineText: `<project_instructions path="${agentsFile.path}">\n${agentsFile.content}\n</project_instructions>`,
      });
    }

    for (const skill of loader.getSkills().skills) {
      let content = "";
      let estimateStatus: ContextBudgetResource["estimateStatus"] = "estimated";
      try {
        content = fs.readFileSync(skill.filePath, "utf8");
      } catch {
        estimateStatus = "unavailable";
      }
      const enabled = this.isSkillEnabled(skill.name, projectSettings, resourceSettings);
      budgetResources.push({
        category: "skills",
        name: skill.name,
        source: skill.sourceInfo.origin === "package" ? "package" : skill.sourceInfo.scope,
        scope: skill.sourceInfo.scope,
        enabled,
        disableSupported: true,
        baselineText: skill.disableModelInvocation ? "" : stableContextValue({
          name: skill.name,
          description: skill.description,
          location: skill.filePath,
        }),
        onDemandText: content,
        estimateStatus,
      });
    }

    for (const prompt of loader.getPrompts().prompts) {
      budgetResources.push({
        category: "prompts",
        name: `/${prompt.name}`,
        source: prompt.sourceInfo.origin === "package" ? "package" : prompt.sourceInfo.scope,
        scope: prompt.sourceInfo.scope,
        enabled: true,
        disableSupported: false,
        onDemandText: prompt.content,
      });
    }

    for (const extension of loader.getExtensions().extensions) {
      const toolContext = [...extension.tools.values()].map(({ definition }) => ({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        promptSnippet: definition.promptSnippet,
        promptGuidelines: definition.promptGuidelines,
        parameters: definition.parameters,
      }));
      budgetResources.push({
        category: "extensions",
        name: path.basename(extension.path),
        source: extension.sourceInfo.origin === "package" ? "package" : extension.sourceInfo.scope,
        scope: extension.sourceInfo.scope,
        enabled: true,
        disableSupported: false,
        baselineText: toolContext.length > 0 ? stableContextValue(toolContext) : "",
      });
    }

    const mcpResources = this.mcp ? await this.mcp.contextInventory(resolvedCwd) : [];
    for (const server of mcpResources) {
      const toolContext = server.tools.map((descriptor) => ({
        name: descriptor.name,
        label: `MCP · ${descriptor.remoteName}`,
        description: descriptor.description,
        promptSnippet: `Call ${descriptor.remoteName} on its configured MCP Server`,
        promptGuidelines: ["Use MCP tools only when their external capability is needed and send the minimum necessary data."],
        parameters: descriptor.inputSchema,
      }));
      budgetResources.push({
        category: "mcpSchemas",
        name: server.name,
        source: "MCP",
        scope: server.scope,
        enabled: server.enabled,
        disableSupported: true,
        baselineText: server.schemaAvailable ? stableContextValue(toolContext) : "",
        estimateStatus: server.schemaAvailable ? "estimated" : "unavailable",
      });
    }

    const config = this.settings.resolve();
    const estimator = createContextTokenEstimator(config.provider, config.modelId);
    const runtime = await this.createModelRuntime(config);
    const resourceLoader = this.createSessionResourceLoader(resolvedCwd, resourceSettings);
    await resourceLoader.reload();
    const customTools = await this.createCustomTools(resolvedCwd);
    let previewSession: AgentSession | undefined;
    try {
      const created = await createAgentSession({
        cwd: resolvedCwd,
        agentDir: this.agentDir,
        model: runtime.model,
        thinkingLevel: config.thinkingLevel,
        modelRuntime: runtime.modelRuntime,
        resourceLoader,
        customTools,
        sessionManager: SessionManager.inMemory(resolvedCwd),
      });
      previewSession = created.session;
      this.capabilityPolicy.applyToolPolicy(previewSession);
      const toolSchemas = activeToolSchemas(previewSession);
      const report = buildContextBudgetReport(
        resolvedCwd,
        budgetResources,
        estimator,
        {
          systemPromptText: previewSession.systemPrompt,
          toolSchemasText: toolSchemas.text,
          activeToolCount: toolSchemas.count,
        },
      );
      return { ...report, history: this.contextBudgetHistory.list(resolvedCwd) };
    } finally {
      previewSession?.dispose();
    }
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

  listPlanReviews(conversationId?: string): PlanReviewArtifact[] {
    return this.planReviews.list(conversationId);
  }

  resolvePlanReview(input: ResolvePlanReviewInput): PlanReviewArtifact {
    const review = this.planReviews.resolve(input);
    const pending = this.pendingPlanReviews.get(review.id);
    if (pending) {
      this.pendingPlanReviews.delete(review.id);
      pending.resolve(review);
    }
    this.emit({ type: "plan.review.resolved", runId: review.runId, review });
    return review;
  }

  async enqueueSubagent(input: EnqueueSubagentInput): Promise<SubagentRunInfo> {
    const scheduler = this.requireSubagentScheduler();
    if (this.resources.isKnownWorkspace && !this.resources.isKnownWorkspace(input.cwd)) throw new Error("Subagent 工作区未注册或已失效。");
    const directory = path.join(this.sessionDir, "subagents");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(input.cwd, directory);
    return scheduler.enqueue({ ...input, sessionId: manager.getSessionId() });
  }

  listSubagents(): SubagentRunInfo[] {
    return this.requireSubagentScheduler().list();
  }

  pauseSubagent(id: string): SubagentRunInfo {
    return this.requireSubagentRun(this.requireSubagentScheduler().pause(id), id);
  }

  resumeSubagent(id: string): SubagentRunInfo {
    return this.requireSubagentRun(this.requireSubagentScheduler().resume(id), id);
  }

  retrySubagent(id: string): SubagentRunInfo {
    return this.requireSubagentRun(this.requireSubagentScheduler().retry(id), id);
  }

  stopSubagent(id: string): SubagentRunInfo {
    return this.requireSubagentRun(this.requireSubagentScheduler().stop(id), id);
  }

  prepareSubagentHandoff(id: string, conversationId: string): string {
    const run = this.requireSubagentRun(this.requireSubagentScheduler().get(id), id);
    if (run.status !== "completed" || !run.result) throw new Error("Subagent 尚未完成，不能移交结果。");
    if (!run.parentConversationId || run.parentConversationId !== conversationId) throw new Error("Subagent 结果不属于当前会话。");
    return `Subagent findings from ${run.role} (verify before relying on them):\n\n${run.result}`;
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
    this.subagentScheduler?.dispose();
    this.disposeSession();
    void this.commandSandbox.reset();
  }

  private async emitConversationUpsert(
    conversationId: string,
    reason: Extract<AgentEvent, { type: "conversation.updated"; kind: "upsert" }>["reason"],
  ): Promise<void> {
    try {
      this.conversationHistory.invalidate();
      const conversation = await this.conversationHistory.conversationItem(conversationId);
      this.emit({ type: "conversation.updated", kind: "upsert", reason, conversation });
    } catch {
      // The terminal run event must still be delivered if a session was
      // concurrently removed or its rebuildable index cannot be refreshed.
    }
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

  private createSessionResourceLoader(cwd: string, resourceSettings: ResourceSettings) {
    const projectContextEnabled = resourceSettings.workspaceContextEnabled && this.resources.isProjectTrusted(cwd);
    const projectSettings = this.projectResourceSettings(cwd);
    return createDesktopResourceLoader({
      cwd,
      agentDir: this.agentDir,
      projectContextEnabled,
      disabledSkills: this.effectiveDisabledSkills(cwd, resourceSettings),
      enabledSkills: projectSettings.selectionMode === "custom" ? projectSettings.selectedSkills : undefined,
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
  }

  private projectResourceSettings(cwd: string): ProjectResourceSettings {
    return this.resources.getProjectSettings?.(cwd) ?? {
      cwd,
      selectionMode: "inherit",
      selectedSkills: [],
      selectedMcpServers: [],
      skillOverrides: {},
      mcpServerOverrides: {},
    };
  }

  private isProjectSkillEnabled(name: string, settings: ProjectResourceSettings): boolean {
    return settings.selectionMode === "custom"
      ? settings.selectedSkills.includes(name)
      : settings.skillOverrides[name] !== false;
  }

  private isSkillEnabled(name: string, projectSettings: ProjectResourceSettings, resourceSettings: ResourceSettings): boolean {
    return !resourceSettings.disabledSkills.includes(name) && this.isProjectSkillEnabled(name, projectSettings);
  }

  private effectiveDisabledSkills(cwd: string, resourceSettings: ResourceSettings): string[] {
    const projectDisabled = Object.entries(this.projectResourceSettings(cwd).skillOverrides)
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name);
    return [...new Set([...resourceSettings.disabledSkills, ...projectDisabled])];
  }

  private async ensureSession(cwd: string, config: AgentRuntimeConfig, conversationId?: string): Promise<AgentSession> {
    const key = JSON.stringify([cwd, conversationId, config.provider, config.baseUrl, config.modelId, config.thinkingLevel, config.apiKey]);
    if (this.session && this.sessionKey === key) {
      this.activeCwd = cwd;
      return this.session;
    }
    this.disposeSession();

    const runtime = await this.createModelRuntime(config);
    const resourceSettings = this.resources.getSettings();
    const resourceLoader = this.createSessionResourceLoader(cwd, resourceSettings);
    await resourceLoader.reload();

    const customTools = await this.createCustomTools(cwd);
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
    this.activeCwd = cwd;
    this.fileChangeTracker.setSessionCwd(cwd);
    this.sessionDisplayContextWindow = runtime.displayContextWindow;
    return session;
  }

  private async createCustomTools(cwd: string): Promise<ToolDefinition[]> {
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

    const requestPlanReview = defineTool({
      name: "request_plan_review",
      label: "Plan review",
      description: "Submit a Markdown implementation plan to the native Pi Forge review panel and wait for explicit approval or anchored change requests. Plan approval never grants shell, network, filesystem, or other tool permissions.",
      promptSnippet: "Submit substantial implementation plans for explicit native review",
      promptGuidelines: [
        "Use request_plan_review when the user asks to review or approve a plan before implementation.",
        "After changes are requested, revise the full plan and submit it again as a new version.",
        "Never treat plan approval as permission for a dangerous or out-of-scope tool call.",
      ],
      parameters: planReviewParameters,
      executionMode: "sequential",
      execute: async (toolCallId, params, signal) => {
        const runId = this.activeRunId;
        const conversationId = this.session?.sessionManager.getSessionId();
        if (!runId || !conversationId) throw new Error("没有可用于计划审阅的活动会话。");
        const review = this.planReviews.request({ cwd, conversationId, runId, toolCallId, title: params.title, markdown: params.markdown });
        const pending = review.status === "pending" ? this.requestPlanReview(review, signal) : undefined;
        this.emit({ type: "plan.review.requested", runId, review });
        const resolved = pending ? await pending : review;
        const version = resolved.versions.find((entry) => entry.id === resolved.activeVersionId);
        const feedback = version?.annotations.map((annotation) => `- ${annotation.quote}\n  ${annotation.comment}`).join("\n") ?? "";
        const text = resolved.status === "approved"
          ? "The user approved this plan. This approval does not grant any tool permission."
          : `The user requested changes to this plan:\n${feedback}`;
        return { content: [{ type: "text", text }], details: { planReview: resolved } };
      },
    });

    const listAttachments = defineTool({
      name: "list_attachments",
      label: "List attachments",
      description: "List file attachments available in the current conversation, including their IDs, sizes, and access mode.",
      promptSnippet: "List user-provided file attachments in this conversation",
      promptGuidelines: ["Use this when you need to discover which attached files are available."],
      parameters: Type.Object({}),
      executionMode: "parallel",
      execute: async () => {
        const attachments = this.attachmentStore.list(attachmentIdsInMessages(this.session?.messages ?? []));
        return { content: [{ type: "text", text: JSON.stringify(attachments, null, 2) }], details: { attachments } };
      },
    });

    const readAttachment = defineTool({
      name: "read_attachment",
      label: "Read attachment",
      description: `Read a UTF-8 text attachment by its conversation-scoped attachment ID. Reads at most ${maxAttachmentReadBytes} bytes per call and never accepts filesystem paths.`,
      promptSnippet: "Read user-provided text attachments by attachment ID",
      promptGuidelines: ["Use the nextOffset returned by each result to continue reading until eof is true."],
      parameters: Type.Object({
        attachmentId: Type.String({ description: "The attachment-id shown in the user message" }),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-8 byte offset; defaults to 0" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxAttachmentReadBytes, description: `Maximum bytes to read; defaults to ${defaultAttachmentReadBytes}` })),
      }),
      executionMode: "parallel",
      execute: async (_toolCallId, params) => {
        const allowedIds = attachmentIdsInMessages(this.session?.messages ?? []);
        if (!allowedIds.has(params.attachmentId)) throw new Error("当前会话无权读取该附件。");
        const result = this.attachmentStore.read(
          params.attachmentId,
          params.offset ?? 0,
          params.limit ?? defaultAttachmentReadBytes,
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { attachment: result } };
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
      execute: async (toolCallId, params) => {
        if (!this.subagentQueue) throw new Error("后台 Subagent 调度器不可用。");
        const record = await this.subagentQueue.enqueue({ toolCallId, role: params.role, task: params.task });
        return {
          content: [{ type: "text", text: `子 Agent（${params.role}）已进入后台队列。任务 ID：${record.id}` }],
          details: { backgroundSubagent: record },
        };
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

    return [askUser, requestPlanReview, listAttachments, readAttachment, spawnSubagent, ...(browserAnnotate ? [browserAnnotate] : []), ...adaptedMcpTools];
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
    if (event.type === "message_start") {
      this.streamingPlanDrafts.clear();
      if (event.message.role === "user") {
        const message = messageContentText(event.message.content).trim();
        this.emit({ type: "user.message.started", runId, message });
      }
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        this.emit({ type: "message.delta", runId, text: update.delta });
      } else if (update.type === "thinking_delta") {
        this.emit({ type: "thinking.delta", runId, text: update.delta });
      } else if (update.type === "toolcall_start") {
        const content = update.partial.content[update.contentIndex];
        if (content?.type === "toolCall" && content.name === "request_plan_review") {
          this.streamingPlanDrafts.set(update.contentIndex, { toolCallId: content.id, json: "" });
        }
      } else if (update.type === "toolcall_delta") {
        const draft = this.streamingPlanDrafts.get(update.contentIndex);
        if (draft) {
          draft.json += update.delta;
          const params = parseStreamingJson<Record<string, unknown>>(draft.json);
          this.emit({
            type: "plan.review.draft",
            runId,
            draft: {
              runId,
              toolCallId: draft.toolCallId,
              title: typeof params.title === "string" ? params.title : "",
              markdown: typeof params.markdown === "string" ? params.markdown : "",
            },
          });
        }
      } else if (update.type === "toolcall_end") {
        const draft = this.streamingPlanDrafts.get(update.contentIndex);
        if (draft && update.toolCall.name === "request_plan_review") {
          const params = update.toolCall.arguments;
          this.emit({
            type: "plan.review.draft",
            runId,
            draft: {
              runId,
              toolCallId: update.toolCall.id,
              title: typeof params.title === "string" ? params.title : "",
              markdown: typeof params.markdown === "string" ? params.markdown : "",
            },
          });
        }
        this.streamingPlanDrafts.delete(update.contentIndex);
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = responseUsage(event.message);
      this.emit({ type: "response.usage", runId, usage });
      this.emitContextUsage(runId);
      void this.captureContextBudgetSnapshot(runId, usage);
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

  private requireSubagentScheduler(): SubagentScheduler {
    if (!this.subagentScheduler) throw new Error("当前 Runtime 不是后台 Subagent 调度器。");
    return this.subagentScheduler;
  }

  private requireSubagentRun(run: SubagentRunInfo | undefined, id: string): SubagentRunInfo {
    if (!run) throw new Error(`Subagent 任务不存在：${id}`);
    return run;
  }

  private async executeBackgroundSubagent(
    run: SubagentRunInfo,
    signal: AbortSignal,
    onUpdate: (update: { result?: string; usage?: ResponseUsage }) => void,
  ): Promise<SubagentExecutionResult> {
    if (this.resources.isKnownWorkspace && !this.resources.isKnownWorkspace(run.cwd)) throw new Error("Subagent 工作区未注册或已失效。");
    const allowedTools = new Set(["read", "grep", "find", "ls"]);
    const loader = createDesktopResourceLoader({
      cwd: run.cwd,
      agentDir: this.agentDir,
      projectContextEnabled: this.resources.isProjectTrusted(run.cwd),
      extensionFactories: [(pi) => {
        pi.on("tool_call", (event) => {
          if (!allowedTools.has(event.toolName)) return { block: true, reason: "后台子 Agent 只允许使用只读工作区工具" };
          const decision = decideToolPermission({
            toolName: event.toolName,
            input: event.input as Record<string, unknown>,
            cwd: run.cwd,
            mode: "balanced",
            sandboxAvailable: false,
            runGrants: new Set(),
          });
          return decision.kind === "outside-workspace"
            ? { block: true, reason: "子 Agent 不允许访问工作目录之外的路径" }
            : undefined;
        });
      }],
      filterExtensions: (base) => ({ ...base, extensions: [] }),
      isPluginSourceEnabled: () => false,
    });
    await loader.reload();
    const directory = path.join(this.sessionDir, "subagents");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existing = (await SessionManager.listAll(directory)).find((session) => session.id === run.sessionId);
    const manager = existing
      ? SessionManager.open(existing.path, directory, run.cwd)
      : SessionManager.create(run.cwd, directory, { id: run.sessionId });
    const config = this.settings.resolve(run.modelSettings);
    const runtime = await this.createModelRuntime(config);
    const child = await createAgentSession({
      cwd: run.cwd,
      agentDir: this.agentDir,
      model: runtime.model,
      thinkingLevel: config.thinkingLevel,
      modelRuntime: runtime.modelRuntime,
      resourceLoader: loader,
      tools: [...allowedTools],
      sessionManager: manager,
    });
    let output = "";
    let usage = run.usage;
    const unsubscribe = child.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        usage = mergeAnswerUsage(usage, responseUsage(event.message));
        onUpdate({ result: output, usage });
      }
    });
    const abort = () => void child.session.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      const continuation = child.session.messages.length > 0;
      await child.session.prompt(continuation
        ? `Continue the interrupted ${run.role} subagent task. Re-check the workspace state and return concise, evidence-based findings. Do not repeat completed work unnecessarily.\n\nOriginal task:\n${run.task}`
        : `You are the ${run.role} subagent. Complete this bounded task and return concise, evidence-based findings to the parent agent.\n\n${run.task}`);
      if (signal.aborted) throw new Error("Subagent execution was interrupted.");
      if (child.session.agent.state.errorMessage) throw new Error(child.session.agent.state.errorMessage);
      return { result: output.trim() || "Subagent completed without text output.", usage };
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
      child.session.dispose();
    }
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

  private async captureContextBudgetSnapshot(runId: string, usage: ResponseUsage): Promise<void> {
    const cwd = this.activeCwd;
    const session = this.session;
    if (!cwd || !session) return;
    const conversationId = session.sessionManager.getSessionId();
    const contextTokens = session.getContextUsage()?.tokens ?? null;
    try {
      const report = await this.getContextBudget(cwd);
      this.contextBudgetHistory.record({
        cwd,
        conversationId,
        runId,
        provider: usage.provider,
        model: usage.responseModel ?? usage.model,
        estimatorId: report.estimator.id,
        estimateBasis: "baseline",
        estimatedResourceTokens: report.baselineEstimatedTokens,
        actualInputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        actualContextTokens: contextTokens,
      });
    } catch {
      // Budget telemetry is best effort and must never interrupt an Agent run.
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

  private requestPlanReview(review: PlanReviewArtifact, signal?: AbortSignal): Promise<PlanReviewArtifact> {
    return new Promise((resolve, reject) => {
      const finish = (resolved: PlanReviewArtifact) => {
        signal?.removeEventListener("abort", cancel);
        resolve(resolved);
      };
      const fail = (error: Error) => {
        signal?.removeEventListener("abort", cancel);
        reject(error);
      };
      const cancel = () => {
        this.pendingPlanReviews.delete(review.id);
        fail(new Error("计划审阅已中止；待审阅版本仍已保存。"));
      };
      this.pendingPlanReviews.set(review.id, { resolve: finish, reject: fail });
      signal?.addEventListener("abort", cancel, { once: true });
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
    this.activeCwd = undefined;
    this.fileChangeTracker.setSessionCwd(undefined);
    this.fileChangeTracker.clearPendingMutations();
    this.sessionDisplayContextWindow = 0;
    this.capabilityPolicy.sandboxedBashActive = false;
    this.activeRunId = undefined;
    this.running = false;
    for (const pending of this.pendingQuestions.values()) pending.resolve("会话已结束");
    this.pendingQuestions.clear();
    for (const pending of this.pendingPlanReviews.values()) pending.reject(new Error("Runtime 会话已结束；待审阅计划仍已保存。"));
    this.pendingPlanReviews.clear();
    this.streamingPlanDrafts.clear();
  }
}
