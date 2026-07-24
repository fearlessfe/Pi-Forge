import {
  createAgentSession,
  createBashTool,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type LoadExtensionsResult,
  type SessionInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type AssistantMessage, type CredentialStore, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CapabilitySettings,
  ConversationHistoryDetail,
  ConversationHistoryItem,
  ContextUsageInfo,
  PluginRuntimeStatus,
  PermissionRuntime,
  PermissionSettings,
  ModelCatalogEntry,
  ProviderCatalogEntry,
  QuestionOption,
  ResponseUsage,
  RuntimeTool,
  SaveModelSettings,
} from "../src/contracts.js";
import { captureAgentSessionEvent } from "./agent-event-adapter.js";
import { decideToolPermission, type PermissionGrant } from "./permission-policy.js";
import { defaultPermissionSettings } from "./permission-store.js";
import { SettingsStore } from "./settings-store.js";
import { WorkspaceCommandSandbox } from "./workspace-command-sandbox.js";
import { mergeAnswerUsage } from "../src/response-usage.js";
import {
  buildProtocolModelMetadataIndex,
  fixedProtocolModelMetadata,
  matchProtocolModelMetadata,
  type ProtocolModelMetadata,
} from "./model-metadata-catalog.js";
import { ModelMetadataStore } from "./model-metadata-store.js";

type EventSink = (event: AgentEvent) => void;

type PendingQuestion = {
  resolve: (answer: string) => void;
};

type RuntimeConfig = ReturnType<SettingsStore["resolve"]>;

type CapabilitySettingsReader = Pick<{ get(): CapabilitySettings }, "get">;
type PermissionSettingsReader = Pick<{ get(): PermissionSettings }, "get">;

type DiscoveredModelsFile = {
  version: 1 | 2;
  providers: Record<string, { baseUrl: string; updatedAt: string; models: ModelCatalogEntry[] }>;
};

const officialMetadataSources: Record<string, string> = {
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  openai: "https://developers.openai.com/api/docs/pricing",
  "openai-codex": "https://developers.openai.com/api/docs/pricing",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  xai: "https://docs.x.ai/developers/models",
  groq: "https://groq.com/pricing",
  mistral: "https://mistral.ai/pricing",
  openrouter: "https://openrouter.ai/models",
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
  "amazon-bedrock": "https://aws.amazon.com/bedrock/pricing/",
  "azure-openai-responses": "https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/",
  "google-vertex": "https://cloud.google.com/vertex-ai/generative-ai/pricing",
};

const builtinSubagentToolName = "pi_desktop_subagent";

type CompatibleProviderDefinition = {
  name: string;
  api: Api;
  baseUrl: string;
  defaultModel: string;
  authHeader: boolean;
};

const compatibleProviderDefinitions: Record<string, CompatibleProviderDefinition> = {
  "openai-compatible": {
    name: "OpenAI Completions Compatible",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen3-coder",
    authHeader: true,
  },
  "openai-responses-compatible": {
    name: "OpenAI Responses Compatible",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:8000/v1",
    defaultModel: "gpt-5",
    authHeader: true,
  },
  "anthropic-compatible": {
    name: "Anthropic Messages Compatible",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8000",
    defaultModel: "claude-sonnet-4-6",
    authHeader: false,
  },
  "google-compatible": {
    name: "Google Generative AI Compatible",
    api: "google-generative-ai",
    baseUrl: "http://127.0.0.1:8000/v1beta",
    defaultModel: "gemini-3-flash-preview",
    authHeader: false,
  },
};

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelEndpoint(provider: string, baseUrl: string): URL {
  const endpoint = new URL(baseUrl);
  const pathName = endpoint.pathname.replace(/\/$/, "");
  if (provider === "anthropic-compatible" && !pathName.endsWith("/v1")) {
    endpoint.pathname = `${pathName}/v1/models`;
  } else {
    endpoint.pathname = `${pathName}/models`;
  }
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function parseDiscoveredModels(payload: unknown, protocol: string): ModelCatalogEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(payload)
        ? payload
        : [];
  const models = candidates.flatMap((candidate): ModelCatalogEntry[] => {
    if (typeof candidate === "string") {
      const id = candidate.replace(/^models\//, "");
      const matched = fixedProtocolModelMetadata(protocol, id);
      return [{ id, name: id, reasoning: true, protocol, contextWindow: matched?.contextWindow ?? 0 }];
    }
    if (!candidate || typeof candidate !== "object") return [];
    const entry = candidate as Record<string, unknown>;
    const rawId = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
    const id = rawId.replace(/^models\//, "").trim();
    if (!id) return [];
    const name = typeof entry.display_name === "string"
      ? entry.display_name
      : typeof entry.displayName === "string"
        ? entry.displayName
        : id;
    const advertisedContextWindow = [entry.contextWindow, entry.context_window, entry.max_context_length]
      .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const matched = fixedProtocolModelMetadata(protocol, id);
    return [{ id, name, reasoning: true, protocol, contextWindow: advertisedContextWindow ?? matched?.contextWindow ?? 0 }];
  });
  return [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

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

function responseUsage(message: AssistantMessage): ResponseUsage {
  return {
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
    requestCount: 1,
    cost: message.usage.cost.total,
  };
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
  private sandboxedBashActive = false;
  private appliedSubagentTool?: string;
  private capabilityFallbackReason?: string;
  private sessionDisplayContextWindow = 0;

  constructor(
    private readonly settings: Pick<SettingsStore, "resolve">,
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
  ) {}

  async getModelCatalog(allowNetwork = true): Promise<ProviderCatalogEntry[]> {
    const runtime = await ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: path.join(this.agentDir, "models.json"),
      modelsStorePath: path.join(this.agentDir, "models-store.json"),
      allowModelNetwork: allowNetwork,
      modelRefreshTimeoutMs: 8_000,
    });
    const builtins = runtime.getProviders().map((provider): ProviderCatalogEntry => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? "",
      kind: "builtin",
      supportsApiKey: Boolean(provider.auth.apiKey),
      supportsOAuth: Boolean(provider.auth.oauth),
      oauthName: provider.auth.oauth?.name,
      models: provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        protocol: model.api,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        pricing: { ...model.cost },
        metadataSource: "official",
        metadataSourceUrl: officialMetadataSources[provider.id],
      })),
    }));
    const protocolMetadata = buildProtocolModelMetadataIndex(builtins.flatMap((provider) => provider.models));
    const discoveredModels = this.readDiscoveredModels();
    const compatible = Object.entries(compatibleProviderDefinitions).map(([id, definition]): ProviderCatalogEntry => {
      const discovered = discoveredModels[id];
      const defaultMetadata = matchProtocolModelMetadata(protocolMetadata, definition.api, definition.defaultModel);
      const models = discovered?.models ?? [{
        id: definition.defaultModel,
        name: definition.defaultModel,
        reasoning: true,
        protocol: definition.api,
        contextWindow: defaultMetadata?.contextWindow ?? 0,
      }];
      return {
        id,
        name: definition.name,
        baseUrl: definition.baseUrl,
        kind: "compatible",
        supportsApiKey: true,
        supportsOAuth: false,
        models: models.map((model) => ({
          ...model,
          protocol: definition.api,
          contextWindow: model.contextWindow || matchProtocolModelMetadata(protocolMetadata, definition.api, model.id)?.contextWindow || 0,
          maxOutputTokens: model.maxOutputTokens
            || matchProtocolModelMetadata(protocolMetadata, definition.api, model.id)?.maxOutputTokens
            || 0,
          pricing: matchProtocolModelMetadata(protocolMetadata, definition.api, model.id)?.pricing
            ?? model.pricing
            ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          metadataSource: matchProtocolModelMetadata(protocolMetadata, definition.api, model.id) ? "official" : "endpoint",
          metadataSourceUrl: matchProtocolModelMetadata(protocolMetadata, definition.api, model.id)?.sourceUrl,
          metadataUpdatedAt: discovered?.updatedAt,
        })),
      };
    });
    return this.modelMetadata.apply([...builtins, ...compatible]);
  }

  async discoverModels(input: SaveModelSettings): Promise<ModelCatalogEntry[]> {
    const compatible = compatibleProviderDefinitions[input.provider];
    if (!compatible) {
      const provider = (await this.getModelCatalog(false)).find((entry) => entry.id === input.provider);
      if (!provider) throw new Error(`Pi SDK 中不存在 provider：${input.provider}。`);
      return provider.models;
    }

    let endpoint: URL;
    try {
      endpoint = modelEndpoint(input.provider, input.baseUrl);
    } catch {
      throw new Error("请先填写有效的 API 地址。");
    }
    const storedCredential = await this.credentials.read(input.provider);
    const apiKey = input.apiKey?.trim() || (storedCredential?.type === "api_key" ? storedCredential.key : undefined);
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) {
      if (input.provider === "anthropic-compatible") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else if (input.provider === "google-compatible") {
        headers["x-goog-api-key"] = apiKey;
      } else {
        headers.authorization = `Bearer ${apiKey}`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "GET", headers, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("获取模型超时，请检查 API 地址和网络连接。");
      throw new Error(`无法连接模型端点：${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`获取模型失败：服务返回 HTTP ${response.status}。请检查 URL 和 API Key。`);
    const body = await response.text();
    if (body.length > 10_000_000) throw new Error("模型列表响应过大，已拒绝处理。");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("模型端点没有返回有效的 JSON。");
    }
    const models = parseDiscoveredModels(payload, compatible.api);
    if (models.length === 0) throw new Error("模型端点返回成功，但没有找到任何模型。");
    this.writeDiscoveredModels(input.provider, input.baseUrl, models);
    return models;
  }

  async send(prompt: string, cwd?: string, conversationId?: string): Promise<string> {
    if (this.running) throw new Error("Agent 正在执行，请先停止当前任务或等待完成。");
    if (!prompt.trim()) throw new Error("消息不能为空。");

    const resolvedCwd = this.resolveCwd(cwd);
    const config = this.settings.resolve();
    const session = await this.ensureSession(resolvedCwd, config, conversationId);
    const runId = randomUUID();
    this.activeRunId = runId;
    this.running = true;
    this.eventSequence = 0;
    this.runPermissionGrants.clear();
    this.emit({ type: "run.started", runId });
    this.emitContextUsage(runId, session);

    void session.prompt(prompt.trim()).then(() => {
      if (this.activeRunId !== runId) return;
      const modelError = session.agent.state.errorMessage;
      this.activeRunId = undefined;
      this.running = false;
      this.emitContextUsage(runId, session);
      if (modelError) this.emit({ type: "run.error", runId, message: modelError });
      else this.emit({ type: "run.completed", runId });
    }).catch((error: unknown) => {
      if (this.activeRunId === runId) {
        this.activeRunId = undefined;
        this.running = false;
        this.emit({ type: "run.error", runId, message: errorMessage(error) });
      }
    });

    return runId;
  }

  async listConversations(): Promise<ConversationHistoryItem[]> {
    const sessions = await SessionManager.listAll(this.sessionDir);
    return sessions
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .map((session) => this.historyItem(session));
  }

  async loadConversation(conversationId: string): Promise<ConversationHistoryDetail> {
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    const manager = SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd);
    const branch = manager.getBranch();
    const turns: ConversationHistoryDetail["turns"] = [];
    let latestAssistant: { message: AssistantMessage; entryIndex: number } | undefined;

    for (const [entryIndex, entry] of branch.entries()) {
      if (entry.type !== "message") continue;
      const record = entry.message as unknown as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "";
      if (role === "user") {
        const question = this.messageText(record.content);
        if (question) turns.push({ id: entry.id, question, answer: "", activities: [] });
        continue;
      }
      const current = turns.at(-1);
      if (!current) continue;

      if (role === "assistant") {
        const assistant = entry.message as AssistantMessage;
        latestAssistant = { message: assistant, entryIndex };
        current.usage = mergeAnswerUsage(current.usage, responseUsage(assistant));
        for (const [contentIndex, content] of assistant.content.entries()) {
          if (content.type === "text") {
            current.answer += content.text;
            current.activities.push({ id: `${entry.id}-message-${contentIndex}`, type: "message", text: content.text });
          }
          else if (content.type === "thinking" && content.thinking) {
            current.activities.push({ id: `${entry.id}-thinking-${contentIndex}`, type: "thinking", text: content.thinking });
          } else if (content.type === "toolCall") {
            if (content.name === "ask_user") {
              const question = typeof content.arguments.question === "string" ? content.arguments.question : "Pi 需要你的回答";
              const options = Array.isArray(content.arguments.options)
                ? content.arguments.options.filter((option): option is QuestionOption => Boolean(option) && typeof option.label === "string")
                : [];
              current.activities.push({ id: content.id, type: "question", question, options, status: "pending" });
            } else {
              current.activities.push({ id: content.id, type: "tool", name: content.name, args: content.arguments, output: "", status: "running" });
            }
          }
        }
      } else if (role === "toolResult") {
        const result = entry.message as ToolResultMessage;
        const activity = current.activities.find((item) => item.id === result.toolCallId);
        if (activity?.type === "tool") {
          activity.output = this.messageText(result.content);
          activity.status = result.isError ? "error" : "success";
        } else if (activity?.type === "question") {
          const answer = result.details && typeof result.details === "object" && typeof (result.details as Record<string, unknown>).answer === "string"
            ? (result.details as Record<string, unknown>).answer as string
            : this.messageText(result.content).replace(/^User answered:\s*/i, "");
          activity.answer = answer;
          activity.status = "answered";
        }
      }
    }

    for (const turn of turns) {
      turn.activities = turn.activities.map((activity) => activity.type === "tool" && activity.status === "running"
        ? { ...activity, status: "error" }
        : activity);
    }

    let contextUsage: ContextUsageInfo | undefined;
    if (latestAssistant) {
      const catalog = await this.getModelCatalog(false);
      const contextWindow = catalog.find((provider) => provider.id === latestAssistant.message.provider)
        ?.models.find((model) => model.id === latestAssistant.message.model)?.contextWindow
        ?? fixedProtocolModelMetadata(latestAssistant.message.api, latestAssistant.message.model)?.contextWindow
        ?? 0;
      if (contextWindow > 0) {
        let latestCompactionIndex = -1;
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          if (branch[index].type === "compaction") {
            latestCompactionIndex = index;
            break;
          }
        }
        const tokens = latestAssistant.entryIndex > latestCompactionIndex ? latestAssistant.message.usage.totalTokens : null;
        contextUsage = { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 };
      }
    }
    return { ...this.historyItem(info), turns, contextUsage };
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再重命名会话。");
    const normalizedTitle = title.trim().replace(/\s+/g, " ");
    if (!normalizedTitle) throw new Error("会话名称不能为空。");
    if (normalizedTitle.length > 60) throw new Error("会话名称不能超过 60 个字符。");
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    if (this.session?.sessionManager.getSessionId() === conversationId) {
      this.session.setSessionName(normalizedTitle);
      return;
    }
    SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd).appendSessionInfo(normalizedTitle);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再删除会话。");
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    if (this.session?.sessionManager.getSessionId() === conversationId) this.disposeSession();
    fs.unlinkSync(info.path);
  }

  async abort(): Promise<void> {
    const runId = this.activeRunId;
    for (const pending of this.pendingQuestions.values()) pending.resolve("用户取消了请求");
    this.pendingQuestions.clear();
    await this.session?.abort();
    if (runId && this.activeRunId === runId) {
      this.emit({ type: "run.stopped", runId });
      this.activeRunId = undefined;
      this.running = false;
    }
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

  async reloadPackages(): Promise<boolean> {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再重新加载插件。");
    if (!this.session) return false;
    await this.session.reload();
    this.applyToolPolicy(this.session);
    return true;
  }

  refreshCapabilities(): PluginRuntimeStatus {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再切换能力提供者。");
    if (this.session) this.applyToolPolicy(this.session);
    return this.getPluginRuntime();
  }

  getPluginRuntime(): PluginRuntimeStatus {
    const capabilitySettings = this.capabilities.get();
    const configuredSubagent = capabilitySettings.subagent;
    if (!this.session) {
      return {
        hasSession: false,
        configuredSubagent,
        effectiveSubagent: { kind: "pending" },
        configuredMemory: capabilitySettings.memory,
        effectiveMemory: { kind: "pending" },
        configuredLearning: capabilitySettings.learning,
        effectiveLearning: { kind: "pending" },
        subagentHistory: capabilitySettings.subagentHistory,
        memoryHistory: capabilitySettings.memoryHistory,
        learningHistory: capabilitySettings.learningHistory,
        tools: [],
      };
    }
    const tools = this.session.getAllTools().map((tool): RuntimeTool => {
      let sourceKind: RuntimeTool["sourceKind"] = "other";
      if (tool.sourceInfo.source === "builtin") sourceKind = "builtin";
      else if (tool.sourceInfo.source === "sdk") sourceKind = "desktop";
      else if (tool.sourceInfo.scope === "project") sourceKind = "project";
      else if (tool.sourceInfo.origin === "package") sourceKind = "package";
      return {
        name: tool.name,
        description: tool.description,
        active: this.session!.getActiveToolNames().includes(tool.name),
        source: tool.sourceInfo.source,
        sourceKind,
      };
    });
    const pluginEffective = configuredSubagent.kind === "plugin"
      && this.appliedSubagentTool === configuredSubagent.toolName
      && !this.capabilityFallbackReason;
    const loadedSources = new Set(this.session.resourceLoader.getExtensions().extensions.map((extension) => extension.sourceInfo.source));
    const effectiveMemory = capabilitySettings.memory.kind === "plugin" && loadedSources.has(capabilitySettings.memory.source)
      ? capabilitySettings.memory
      : { kind: "none" as const };
    const effectiveLearning = capabilitySettings.learning.kind === "plugin" && loadedSources.has(capabilitySettings.learning.source)
      ? capabilitySettings.learning
      : { kind: "none" as const };
    return {
      hasSession: true,
      configuredSubagent,
      effectiveSubagent: pluginEffective ? configuredSubagent : { kind: "builtin" },
      configuredMemory: capabilitySettings.memory,
      effectiveMemory,
      configuredLearning: capabilitySettings.learning,
      effectiveLearning,
      subagentHistory: capabilitySettings.subagentHistory,
      memoryHistory: capabilitySettings.memoryHistory,
      learningHistory: capabilitySettings.learningHistory,
      fallbackReason: this.capabilityFallbackReason,
      tools,
    };
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

  private readDiscoveredModels(): DiscoveredModelsFile["providers"] {
    try {
      const filePath = path.join(this.agentDir, "discovered-models.json");
      if (!fs.existsSync(filePath)) return {};
      const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DiscoveredModelsFile>;
      if ((stored.version !== 1 && stored.version !== 2) || !stored.providers || typeof stored.providers !== "object") return {};
      const providers: DiscoveredModelsFile["providers"] = {};
      for (const [providerId, entry] of Object.entries(stored.providers)) {
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.models)) continue;
        const protocol = compatibleProviderDefinitions[providerId]?.api;
        const models = entry.models.filter((model): model is ModelCatalogEntry => (
          Boolean(model)
          && typeof model.id === "string"
          && typeof model.name === "string"
          && typeof model.reasoning === "boolean"
        )).map((model) => {
          const knownContextWindow = protocol ? fixedProtocolModelMetadata(protocol, model.id)?.contextWindow : undefined;
          const storedContextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 0;
          // Version 1 used 128K as an unconditional fallback, so that value is
          // not trustworthy unless the model is now covered by known metadata.
          const contextWindow = knownContextWindow ?? (stored.version === 1 && storedContextWindow === 128_000 ? 0 : storedContextWindow);
          return { ...model, protocol: model.protocol ?? protocol, contextWindow };
        });
        if (models.length === 0) continue;
        providers[providerId] = {
          baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
          models,
        };
      }
      return providers;
    } catch {
      return {};
    }
  }

  private writeDiscoveredModels(providerId: string, baseUrl: string, models: ModelCatalogEntry[]): void {
    const filePath = path.join(this.agentDir, "discovered-models.json");
    const temporaryPath = `${filePath}.tmp`;
    const providers = this.readDiscoveredModels();
    providers[providerId] = { baseUrl: baseUrl.replace(/\/$/, ""), updatedAt: new Date().toISOString(), models };
    fs.mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 2, providers } satisfies DiscoveredModelsFile, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  }

  private historyItem(session: SessionInfo): ConversationHistoryItem {
    const isProject = Boolean(session.cwd) && path.resolve(session.cwd) !== path.resolve(this.fallbackCwd);
    const title = session.name?.trim() || session.firstMessage.trim().replace(/\s+/g, " ") || "未命名对话";
    return {
      id: session.id,
      title: title.length > 60 ? `${title.slice(0, 60)}…` : title,
      cwd: session.cwd || this.fallbackCwd,
      createdAt: session.created.toISOString(),
      updatedAt: session.modified.toISOString(),
      project: isProject ? { id: session.cwd, name: path.basename(session.cwd), path: session.cwd } : undefined,
    };
  }

  private messageText(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
    }).join("\n").trim();
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

  private async ensureSession(cwd: string, config: RuntimeConfig, conversationId?: string): Promise<AgentSession> {
    const key = JSON.stringify([cwd, conversationId, config.provider, config.baseUrl, config.modelId, config.thinkingLevel, config.apiKey]);
    if (this.session && this.sessionKey === key) return this.session;
    this.disposeSession();

    const runtime = await this.createModelRuntime(config);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      extensionFactories: [
        (pi) => {
          const sandboxedBash = createBashTool(cwd, { operations: this.commandSandbox.createOperations() });
          pi.registerTool({ ...sandboxedBash, label: "bash (workspace sandbox)" });
          pi.on("tool_call", async (event) => {
            if (!this.activeRunId) return undefined;
            const input = event.input as Record<string, unknown>;
            const mode = this.permissions.get().mode;
            const sandboxAvailable = event.toolName === "bash" && mode === "balanced" && this.sandboxedBashActive
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
      extensionsOverride: (base) => this.filterCapabilityExtensions(base),
    });
    await resourceLoader.reload();

    const customTools = this.createCustomTools(cwd, runtime);
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

    this.applyToolPolicy(session);
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
    this.session = session;
    this.sessionKey = key;
    this.sessionDisplayContextWindow = runtime.displayContextWindow;
    return session;
  }

  private createCustomTools(
    cwd: string,
    runtime: Awaited<ReturnType<AgentService["createModelRuntime"]>>,
  ): ToolDefinition[] {
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
      execute: async (_toolCallId, params, signal, onUpdate) => {
        const childLoader = new DefaultResourceLoader({
          cwd,
          agentDir: this.agentDir,
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
        });
        await childLoader.reload();
        const child = await createAgentSession({
          cwd,
          agentDir: this.agentDir,
          model: runtime.model,
          thinkingLevel: runtime.thinkingLevel,
          modelRuntime: runtime.modelRuntime,
          resourceLoader: childLoader,
          tools: ["read", "grep", "find", "ls"],
          sessionManager: SessionManager.inMemory(cwd),
        });
        let output = "";
        let activity = `子 Agent（${params.role}）已启动…`;
        const unsubscribe = child.session.subscribe((event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            output += event.assistantMessageEvent.delta;
            activity = output;
          } else if (event.type === "tool_execution_start") {
            activity = `${output}\n\n正在调用 ${event.toolName}…`.trim();
          }
          onUpdate?.({
            content: [{ type: "text", text: activity }],
            details: { role: params.role, status: "running" },
          });
        });
        const abortChild = () => void child.session.abort();
        signal?.addEventListener("abort", abortChild, { once: true });
        try {
          await child.session.prompt(`You are the ${params.role} subagent. Complete this bounded task and return concise, evidence-based findings to the parent agent.\n\n${params.task}`);
          if (child.session.agent.state.errorMessage) throw new Error(child.session.agent.state.errorMessage);
          return {
            content: [{ type: "text", text: output.trim() || "Subagent completed without text output." }],
            details: { role: params.role, status: "completed" },
          };
        } finally {
          signal?.removeEventListener("abort", abortChild);
          unsubscribe();
          child.session.dispose();
        }
      },
    });

    return [askUser, spawnSubagent];
  }

  private applyToolPolicy(session: AgentSession): void {
    this.sandboxedBashActive = session.getToolDefinition("bash")?.label === "bash (workspace sandbox)";
    const activeTools = new Set(session.getActiveToolNames());
    for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user"]) {
      if (session.getToolDefinition(name)) activeTools.add(name);
    }
    if (this.appliedSubagentTool) activeTools.delete(this.appliedSubagentTool);
    activeTools.delete(builtinSubagentToolName);
    this.capabilityFallbackReason = undefined;

    const configured = this.capabilities.get().subagent;
    if (configured.kind === "plugin") {
      const extensionTool = session.extensionRunner.getAllRegisteredTools()
        .find((tool) => tool.definition.name === configured.toolName && tool.sourceInfo.source === configured.source);
      const resolvedTool = session.getAllTools().find((tool) => tool.name === configured.toolName);
      const resolvesToExtension = resolvedTool
        && resolvedTool.sourceInfo.source !== "sdk"
        && resolvedTool.sourceInfo.source !== "builtin"
        && resolvedTool.sourceInfo.source === configured.source;
      if (extensionTool && resolvesToExtension && configured.toolName !== builtinSubagentToolName) {
        activeTools.add(configured.toolName);
        this.appliedSubagentTool = configured.toolName;
      } else {
        activeTools.add(builtinSubagentToolName);
        this.appliedSubagentTool = builtinSubagentToolName;
        this.capabilityFallbackReason = `${configured.source} 的工具 ${configured.toolName} 未成功注册，已回退到内置 Subagent。`;
      }
    } else {
      activeTools.add(builtinSubagentToolName);
      this.appliedSubagentTool = builtinSubagentToolName;
    }
    session.setActiveToolsByName([...activeTools]);
  }

  private filterCapabilityExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
    const settings = this.capabilities.get();
    const activeSources = new Set<string>();
    if (settings.subagent.kind === "plugin") activeSources.add(settings.subagent.source);
    if (settings.memory.kind === "plugin") activeSources.add(settings.memory.source);
    if (settings.learning.kind === "plugin") activeSources.add(settings.learning.source);

    const historicalSources = new Set<string>();
    for (const provider of settings.subagentHistory) if (provider.kind === "plugin") historicalSources.add(provider.source);
    for (const provider of settings.memoryHistory) if (provider.kind === "plugin") historicalSources.add(provider.source);
    for (const provider of settings.learningHistory) if (provider.kind === "plugin") historicalSources.add(provider.source);
    for (const source of activeSources) historicalSources.delete(source);

    return {
      ...base,
      extensions: base.extensions.filter((extension) => !historicalSources.has(extension.sourceInfo.source)),
    };
  }

  private async createModelRuntime(config: RuntimeConfig) {
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
      const discoveredModel = this.readDiscoveredModels()[config.provider]?.models.find((model) => model.id === config.modelId);
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
        ? this.readDiscoveredModels()[config.provider]?.models.find((entry) => entry.id === config.modelId)?.contextWindow
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
    } else if (event.type === "tool_execution_start") {
      this.emit({ type: "tool.started", runId, callId: event.toolCallId, name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_update") {
      this.emit({ type: "tool.updated", runId, callId: event.toolCallId, name: event.toolName, output: resultText(event.partialResult) });
    } else if (event.type === "tool_execution_end") {
      this.emit({
        type: "tool.completed",
        runId,
        callId: event.toolCallId,
        name: event.toolName,
        output: resultText(event.result),
        isError: event.isError,
      });
    }
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
    this.sessionDisplayContextWindow = 0;
    this.sandboxedBashActive = false;
    this.activeRunId = undefined;
    this.running = false;
    for (const pending of this.pendingQuestions.values()) pending.resolve("会话已结束");
    this.pendingQuestions.clear();
  }
}
