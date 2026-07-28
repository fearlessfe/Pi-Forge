import {
  createAgentSession,
  createBashTool,
  DefaultResourceLoader,
  defineTool,
  generateUnifiedPatch,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type LoadExtensionsResult,
  type SessionInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type AssistantMessage, type CredentialStore, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  ResourceSettings,
  ResourceInventory,
  WorkspaceTrustStatus,
  RuntimeTool,
  SaveModelSettings,
  TaskFileChange,
  ToolActivityDetails,
} from "../src/contracts.js";
import { captureAgentSessionEvent } from "./agent-event-adapter.js";
import { decideToolPermission, isInsideWorkspace, type PermissionGrant } from "./permission-policy.js";
import { defaultPermissionSettings } from "./permission-store.js";
import type { ThinkingLevel } from "../src/contracts.js";
import { WorkspaceCommandSandbox } from "./workspace-command-sandbox.js";
import { mergeAnswerUsage } from "../src/response-usage.js";
import {
  buildProtocolModelMetadataIndex,
  fixedProtocolModelMetadata,
  matchProtocolModelMetadata,
  type ProtocolModelMetadata,
} from "./model-metadata-catalog.js";
import { ModelMetadataStore } from "./model-metadata-store.js";
import type { McpToolDescriptor } from "./mcp-service.js";
import type { BrowserDebugPort } from "./browser-service.js";
import { SubagentRunStore } from "./subagent-run-store.js";

type EventSink = (event: AgentEvent) => void;

type PendingQuestion = {
  resolve: (answer: string) => void;
};

type PendingFileMutation = {
  cwd: string;
  path: string;
  existed: boolean;
  before?: Buffer;
  beforeHash?: string;
};

type ConversationMetadata = {
  tags: string[];
  archived: boolean;
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
const maxDiffSnapshotBytes = 5 * 1024 * 1024;
const fileChangesEntryType = "pi-desktop:file-changes";

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

const initProjectPrompt = `Initialize the current workspace for future coding-agent sessions by creating or updating AGENTS.md at the workspace root.

Work autonomously and make the file change directly.

Goal:
Create a compact, high-signal instruction file that helps future agents avoid mistakes and become productive quickly. Every line should answer: "Would an agent likely miss or guess this incorrectly without help?" If not, omit it.

Investigation:
1. Read the existing AGENTS.md, if present, before editing it. Preserve accurate project-specific and manually added guidance.
2. Inspect the highest-value sources first:
   - README and contribution documentation;
   - root manifests, workspace configuration, lockfiles, and task-runner files;
   - build, development, test, lint, format, typecheck, code-generation, and migration configuration;
   - CI workflows and pre-commit configuration;
   - existing agent instructions such as CLAUDE.md, GEMINI.md, .cursor/rules, .cursorrules, and .github/copilot-instructions.md.
3. If the architecture or workflow remains unclear, inspect a small number of representative entrypoints, core modules, and tests. Prefer files that explain how the system is wired together over random leaf files.
4. Prefer executable sources of truth over prose. If documentation conflicts with scripts, configuration, or CI, trust the executable source and document the discrepancy only when it affects agent work.
5. Ask the user only when an important convention cannot be determined from the workspace. Ask at most one concise batch of questions; otherwise proceed autonomously.

What to document:
- the project's purpose and non-obvious architecture, package, process, or ownership boundaries;
- important directories and real entrypoints, without an exhaustive file inventory;
- exact setup, development, build, lint, format, typecheck, test, and packaging commands that are actually available;
- focused commands for one test, package, or verification step, plus required command ordering or prerequisites when relevant;
- repository-specific coding, testing, security, persistence, localization, or workflow conventions that differ from tool defaults;
- generated files, code generation, migrations, fixtures, snapshots, environment loading, required external services, expensive suites, platform limitations, and other verified pitfalls.

Writing rules:
- Update stale claims instead of blindly appending or replacing the file.
- Include only verified, project-specific guidance that changes how an agent should work.
- Do not invent commands, architecture, conventions, prerequisites, or secrets.
- Do not include generic software advice, long tutorials, speculative recommendations, or content already obvious from filenames.
- Prefer short sections and actionable bullets. Keep a simple workspace simple.
- For a non-code workspace, describe its purpose, key files, and how its contents are used instead of inventing software-development sections.

After writing AGENTS.md, briefly summarize what changed, which important sources were checked, which validation commands were run, and any gaps that could not be verified.`;

function expandDesktopCommand(prompt: string): string {
  return prompt.trim() === "/init" ? initProjectPrompt : prompt;
}

function displayUserPrompt(prompt: string): string {
  return prompt.trim() === initProjectPrompt ? "/init" : prompt;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStoredFileChange(value: unknown): TaskFileChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const change = value as Record<string, unknown>;
  if (
    typeof change.id !== "string"
    || typeof change.runId !== "string"
    || typeof change.callId !== "string"
    || typeof change.path !== "string"
    || typeof change.relativePath !== "string"
    || (change.kind !== "created" && change.kind !== "modified")
    || typeof change.patch !== "string"
    || typeof change.afterHash !== "string"
    || (change.status !== "pending" && change.status !== "accepted" && change.status !== "reverted" && change.status !== "conflict")
  ) return undefined;
  return {
    id: change.id,
    runId: change.runId,
    callId: change.callId,
    path: change.path,
    relativePath: change.relativePath,
    kind: change.kind,
    patch: change.patch,
    beforeHash: typeof change.beforeHash === "string" ? change.beforeHash : undefined,
    afterHash: change.afterHash,
    status: change.status,
    // Modified files need an in-memory before snapshot, which is intentionally not persisted.
    revertible: change.kind === "created" && change.revertible === true,
    error: typeof change.error === "string" ? change.error : undefined,
  };
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

function resultDetails(result: unknown): ToolActivityDetails | undefined {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" ? details as ToolActivityDetails : undefined;
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
  private readonly pendingFileMutations = new Map<string, PendingFileMutation>();
  private readonly fileChanges = new Map<string, TaskFileChange>();
  private readonly changeSnapshots = new Map<string, Buffer | undefined>();
  private lastChangeRunId?: string;
  private sessionCwd?: string;
  private subagentRunStore?: SubagentRunStore;

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
    this.lastChangeRunId = runId;
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

    void session.prompt(expandDesktopCommand(prompt.trim())).then(() => {
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
    const sessions = await SessionManager.listAll(this.sessionDir);
    const idsByPath = new Map(sessions.map((session) => [path.resolve(session.path), session.id]));
    return sessions
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .map((session) => this.historyItem(
        session,
        this.conversationMetadata(SessionManager.open(session.path, this.sessionDir, session.cwd || this.fallbackCwd)),
        session.parentSessionPath ? idsByPath.get(path.resolve(session.parentSessionPath)) : undefined,
      ));
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
      if (entry.type === "custom" && entry.customType === fileChangesEntryType) {
        const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
        const changes = Array.isArray(data.changes) ? data.changes.map(parseStoredFileChange).filter((change): change is TaskFileChange => Boolean(change)) : [];
        const current = turns.at(-1);
        if (current) current.fileChanges = changes;
        for (const change of changes) this.fileChanges.set(change.id, change);
        if (typeof data.runId === "string") this.lastChangeRunId = data.runId;
        continue;
      }
      if (entry.type !== "message") continue;
      const record = entry.message as unknown as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "";
      if (role === "user") {
        const question = displayUserPrompt(this.messageText(record.content));
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
          const details = result.details && typeof result.details === "object" ? result.details as ToolActivityDetails : undefined;
          const subagent = activity.name === builtinSubagentToolName
            ? this.subagentRuns().findByToolCall(result.toolCallId, conversationId) ?? details?.subagent
            : undefined;
          activity.details = subagent ? { ...details, subagent } : details;
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
    const sessionsByPath = new Map(sessions.map((session) => [path.resolve(session.path), session.id]));
    return {
      ...this.historyItem(
        info,
        this.conversationMetadata(manager),
        info.parentSessionPath ? sessionsByPath.get(path.resolve(info.parentSessionPath)) : undefined,
      ),
      turns,
      contextUsage,
    };
  }

  async forkConversation(conversationId: string, entryId?: string): Promise<ConversationHistoryItem> {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再 Fork 会话。");
    const { info, sessions } = await this.findConversation(conversationId);
    const source = SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd);
    const sourceMetadata = this.conversationMetadata(source);
    let fork: SessionManager;
    if (entryId) {
      if (!source.getEntry(entryId)) throw new Error("选择的会话节点不存在，请重新打开会话后再试。");
      const branch = source.getBranch();
      const selectedIndex = branch.findIndex((entry) => entry.id === entryId);
      let forkLeafId = entryId;
      for (let index = selectedIndex + 1; index < branch.length; index += 1) {
        const entry = branch[index];
        if (entry.type === "message" && (entry.message as unknown as { role?: string }).role === "user") break;
        if (entry.type !== "session_info" && !(entry.type === "custom" && entry.customType === "pi-desktop:conversation-metadata")) forkLeafId = entry.id;
      }
      const forkPath = source.createBranchedSession(forkLeafId);
      if (!forkPath) throw new Error("无法为临时会话创建 Fork。");
      fork = SessionManager.open(forkPath, this.sessionDir, info.cwd || this.fallbackCwd);
    } else {
      fork = SessionManager.forkFrom(info.path, info.cwd || this.fallbackCwd, this.sessionDir);
    }
    fork.appendSessionInfo(`Fork · ${info.name?.trim() || info.firstMessage.trim() || "未命名对话"}`.slice(0, 60));
    fork.appendCustomEntry("pi-desktop:conversation-metadata", { tags: sourceMetadata.tags, archived: false });
    const forkInfo = (await SessionManager.listAll(this.sessionDir)).find((session) => session.id === fork.getSessionId());
    if (!forkInfo) throw new Error("Fork 已创建，但无法重新读取会话索引。");
    const idsByPath = new Map([...sessions, forkInfo].map((session) => [path.resolve(session.path), session.id]));
    return this.historyItem(forkInfo, this.conversationMetadata(fork), forkInfo.parentSessionPath ? idsByPath.get(path.resolve(forkInfo.parentSessionPath)) : conversationId);
  }

  async exportConversation(conversationId: string, format: "markdown" | "json"): Promise<{ filename: string; mimeType: "text/markdown" | "application/json"; content: string }> {
    const detail = await this.loadConversation(conversationId);
    const safeName = detail.title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "conversation";
    if (format === "json") {
      return {
        filename: `${safeName}.json`,
        mimeType: "application/json",
        content: JSON.stringify(detail, null, 2),
      };
    }
    const lines = [
      `# ${detail.title}`,
      "",
      `- Created: ${detail.createdAt}`,
      `- Updated: ${detail.updatedAt}`,
      `- Workspace: ${detail.cwd}`,
      ...(detail.tags.length > 0 ? [`- Tags: ${detail.tags.join(", ")}`] : []),
      "",
    ];
    for (const turn of detail.turns) {
      lines.push("## User", "", turn.question, "", "## Pi", "", turn.answer || "_(No text response)_", "");
    }
    return { filename: `${safeName}.md`, mimeType: "text/markdown", content: lines.join("\n") };
  }

  async setConversationArchived(conversationId: string, archived: boolean): Promise<void> {
    await this.updateConversationMetadata(conversationId, { archived });
  }

  async setConversationTags(conversationId: string, tags: string[]): Promise<void> {
    const normalized = [...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, " ")).filter(Boolean))];
    if (normalized.length > 8 || normalized.some((tag) => tag.length > 24)) throw new Error("会话最多设置 8 个标签，每个标签不超过 24 个字符。");
    await this.updateConversationMetadata(conversationId, { tags: normalized });
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
      this.persistFileChanges(runId);
      this.emit({ type: "run.stopped", runId });
      this.activeRunId = undefined;
      this.running = false;
    }
  }

  async queueMessage(prompt: string, mode: "steer" | "followUp"): Promise<{ steering: string[]; followUp: string[] }> {
    if (!this.running || !this.session) throw new Error("当前没有正在运行的 Agent 任务。");
    const normalized = prompt.trim();
    if (!normalized) throw new Error("排队消息不能为空。");
    if (mode === "steer") await this.session.steer(normalized);
    else await this.session.followUp(normalized);
    return this.currentQueue();
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    if (!this.session) return { steering: [], followUp: [] };
    this.session.clearQueue();
    const queue = this.currentQueue();
    if (this.activeRunId) this.emit({ type: "queue.updated", runId: this.activeRunId, queue });
    return queue;
  }

  listChanges(runId = this.lastChangeRunId): TaskFileChange[] {
    if (!runId) return [];
    return [...this.fileChanges.values()].filter((change) => change.runId === runId).map((change) => ({ ...change }));
  }

  changePath(changeId: string): string {
    const change = this.fileChanges.get(changeId);
    if (!change) throw new Error("找不到该文件变更，请重新打开会话后再试。");
    if (!path.isAbsolute(change.path) || !fs.existsSync(change.path) || !fs.statSync(change.path).isFile()) {
      throw new Error("成果物不存在或已被移动。");
    }
    return change.path;
  }

  acceptChanges(changeIds?: string[]): TaskFileChange[] {
    const selected = this.selectedChanges(changeIds);
    const runs = new Set<string>();
    for (const change of selected) {
      if (change.status !== "pending" && change.status !== "conflict") continue;
      change.status = "accepted";
      change.error = undefined;
      this.changeSnapshots.delete(change.id);
      runs.add(change.runId);
    }
    this.emitChangedRuns(runs);
    return this.listChanges(selected[0]?.runId);
  }

  revertChanges(changeIds?: string[]): TaskFileChange[] {
    const selected = this.selectedChanges(changeIds).reverse();
    const runs = new Set<string>();
    for (const change of selected) {
      if (change.status !== "pending") continue;
      runs.add(change.runId);
      if (!change.revertible) {
        change.status = "conflict";
        change.error = "该文件超过安全快照上限，无法自动回退。";
        continue;
      }
      try {
        const currentHash = fs.existsSync(change.path) && fs.statSync(change.path).isFile() ? this.hashFile(change.path) : undefined;
        if (currentHash !== change.afterHash) {
          change.status = "conflict";
          change.error = "文件在 Agent 修改后又发生了变化，已停止回退以避免覆盖新内容。";
          continue;
        }
        if (change.kind === "created") {
          fs.unlinkSync(change.path);
        } else {
          const before = this.changeSnapshots.get(change.id);
          if (!before) throw new Error("回退快照不可用。");
          fs.writeFileSync(change.path, before);
        }
        change.status = "reverted";
        change.error = undefined;
        this.changeSnapshots.delete(change.id);
      } catch (error) {
        change.status = "conflict";
        change.error = errorMessage(error);
      }
    }
    this.emitChangedRuns(runs);
    return this.listChanges(selected[0]?.runId);
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
    const loader = new DefaultResourceLoader({
      cwd: resolvedCwd,
      agentDir: this.agentDir,
      settingsManager: SettingsManager.create(resolvedCwd, this.agentDir, { projectTrusted: projectContextEnabled }),
      noContextFiles: !projectContextEnabled,
      extensionsOverride: (base) => this.filterCapabilityExtensions(base, resolvedCwd),
      skillsOverride: (base) => ({
        ...base,
        skills: base.skills.filter((skill) => this.isPluginSourceEnabled(skill.sourceInfo.source, resolvedCwd)),
      }),
      promptsOverride: (base) => ({
        ...base,
        prompts: base.prompts.filter((prompt) => this.isPluginSourceEnabled(prompt.sourceInfo.source, resolvedCwd)),
      }),
      themesOverride: (base) => ({
        ...base,
        themes: base.themes.filter((theme) => this.isPluginSourceEnabled(theme.sourceInfo?.source ?? "local", resolvedCwd)),
      }),
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

  private historyItem(session: SessionInfo, metadata: ConversationMetadata = { tags: [], archived: false }, parentConversationId?: string): ConversationHistoryItem {
    const isProject = Boolean(session.cwd) && path.resolve(session.cwd) !== path.resolve(this.fallbackCwd);
    const title = session.name?.trim() || displayUserPrompt(session.firstMessage).trim().replace(/\s+/g, " ") || "未命名对话";
    return {
      id: session.id,
      title: title.length > 60 ? `${title.slice(0, 60)}…` : title,
      cwd: session.cwd || this.fallbackCwd,
      createdAt: session.created.toISOString(),
      updatedAt: session.modified.toISOString(),
      tags: metadata.tags,
      archived: metadata.archived,
      searchText: session.allMessagesText.slice(0, 200_000),
      parentConversationId,
      project: isProject ? { id: session.cwd, name: path.basename(session.cwd), path: session.cwd } : undefined,
    };
  }

  private conversationMetadata(manager: SessionManager): ConversationMetadata {
    const metadata = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-desktop:conversation-metadata").at(-1);
    if (!metadata || metadata.type !== "custom" || !metadata.data || typeof metadata.data !== "object") return { tags: [], archived: false };
    const data = metadata.data as Record<string, unknown>;
    return {
      tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8) : [],
      archived: data.archived === true,
    };
  }

  private async findConversation(conversationId: string): Promise<{ info: SessionInfo; sessions: SessionInfo[] }> {
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    return { info, sessions };
  }

  private async updateConversationMetadata(conversationId: string, patch: Partial<ConversationMetadata>): Promise<void> {
    if (this.running) throw new Error("Agent 正在执行，请等待任务完成后再修改会话。");
    const { info } = await this.findConversation(conversationId);
    const manager = this.session?.sessionManager.getSessionId() === conversationId
      ? this.session.sessionManager
      : SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd);
    manager.appendCustomEntry("pi-desktop:conversation-metadata", { ...this.conversationMetadata(manager), ...patch });
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

  private async ensureSession(cwd: string, config: AgentRuntimeConfig, conversationId?: string): Promise<AgentSession> {
    const key = JSON.stringify([cwd, conversationId, config.provider, config.baseUrl, config.modelId, config.thinkingLevel, config.apiKey]);
    if (this.session && this.sessionKey === key) return this.session;
    this.disposeSession();

    const runtime = await this.createModelRuntime(config);
    const resourceSettings = this.resources.getSettings();
    const projectContextEnabled = resourceSettings.workspaceContextEnabled && this.resources.isProjectTrusted(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager: SettingsManager.create(cwd, this.agentDir, { projectTrusted: projectContextEnabled }),
      noContextFiles: !projectContextEnabled,
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
      extensionsOverride: (base) => this.filterCapabilityExtensions(base, cwd),
      skillsOverride: (base) => ({
        ...base,
        skills: base.skills.filter((skill) => (
          !resourceSettings.disabledSkills.includes(skill.name)
          && this.isPluginSourceEnabled(skill.sourceInfo.source, cwd)
        )),
      }),
      promptsOverride: (base) => ({
        ...base,
        prompts: base.prompts.filter((prompt) => this.isPluginSourceEnabled(prompt.sourceInfo.source, cwd)),
      }),
      themesOverride: (base) => ({
        ...base,
        themes: base.themes.filter((theme) => this.isPluginSourceEnabled(theme.sourceInfo?.source ?? "local", cwd)),
      }),
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

    this.applyToolPolicy(session);
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
    this.session = session;
    this.sessionKey = key;
    this.sessionCwd = cwd;
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
        const childLoader = new DefaultResourceLoader({
          cwd,
          agentDir: this.agentDir,
          settingsManager: SettingsManager.create(cwd, this.agentDir, { projectTrusted: this.resources.isProjectTrusted(cwd) }),
          noContextFiles: !this.resources.isProjectTrusted(cwd),
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
          extensionsOverride: (base) => this.filterCapabilityExtensions(base, cwd),
          skillsOverride: (base) => ({
            ...base,
            skills: base.skills.filter((skill) => this.isPluginSourceEnabled(skill.sourceInfo.source, cwd)),
          }),
          promptsOverride: (base) => ({
            ...base,
            prompts: base.prompts.filter((prompt) => this.isPluginSourceEnabled(prompt.sourceInfo.source, cwd)),
          }),
          themesOverride: (base) => ({
            ...base,
            themes: base.themes.filter((theme) => this.isPluginSourceEnabled(theme.sourceInfo?.source ?? "local", cwd)),
          }),
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

  private filterCapabilityExtensions(base: LoadExtensionsResult, cwd?: string): LoadExtensionsResult {
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
      extensions: base.extensions.filter((extension) => (
        !historicalSources.has(extension.sourceInfo.source)
        && this.isPluginSourceEnabled(extension.sourceInfo.source, cwd)
      )),
    };
  }

  private isPluginSourceEnabled(source: string, cwd?: string): boolean {
    return !source.startsWith("npm:") || !this.pluginSecurity || this.pluginSecurity.isEnabled(source, cwd);
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
    } else if (event.type === "queue_update") {
      this.emit({ type: "queue.updated", runId, queue: { steering: [...event.steering], followUp: [...event.followUp] } });
    } else if (event.type === "tool_execution_start") {
      this.captureFileMutationStart(event.toolCallId, event.toolName, event.args);
      this.emit({ type: "tool.started", runId, callId: event.toolCallId, name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_update") {
      this.emit({ type: "tool.updated", runId, callId: event.toolCallId, name: event.toolName, output: resultText(event.partialResult), details: resultDetails(event.partialResult) });
    } else if (event.type === "tool_execution_end") {
      this.captureFileMutationEnd(runId, event.toolCallId, event.toolName, event.result, event.isError);
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

  private captureFileMutationStart(callId: string, toolName: string, args: unknown): void {
    if ((toolName !== "edit" && toolName !== "write") || !this.sessionCwd || !args || typeof args !== "object") return;
    const candidate = (args as Record<string, unknown>).path;
    if (typeof candidate !== "string" || !candidate || !isInsideWorkspace(this.sessionCwd, candidate)) return;
    const absolutePath = path.resolve(this.sessionCwd, candidate);
    const existed = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
    let before: Buffer | undefined;
    let beforeHash: string | undefined;
    if (existed) {
      const size = fs.statSync(absolutePath).size;
      if (size <= maxDiffSnapshotBytes) before = fs.readFileSync(absolutePath);
      beforeHash = before ? this.hashBuffer(before) : this.hashFile(absolutePath);
    }
    this.pendingFileMutations.set(callId, { cwd: this.sessionCwd, path: absolutePath, existed, before, beforeHash });
  }

  private captureFileMutationEnd(runId: string, callId: string, toolName: string, result: unknown, isError: boolean): void {
    const pending = this.pendingFileMutations.get(callId);
    this.pendingFileMutations.delete(callId);
    if (!pending || isError || (toolName !== "edit" && toolName !== "write") || !fs.existsSync(pending.path) || !fs.statSync(pending.path).isFile()) return;
    const size = fs.statSync(pending.path).size;
    const after = size <= maxDiffSnapshotBytes ? fs.readFileSync(pending.path) : undefined;
    const afterHash = after ? this.hashBuffer(after) : this.hashFile(pending.path);
    if (pending.beforeHash === afterHash) return;
    const relativePath = path.relative(pending.cwd, pending.path) || path.basename(pending.path);
    let patch = "";
    if (after && (!pending.existed || pending.before) && !after.includes(0) && !pending.before?.includes(0)) {
      patch = generateUnifiedPatch(relativePath, pending.before?.toString("utf8") ?? "", after.toString("utf8"));
    } else if (result && typeof result === "object") {
      const details = (result as { details?: { patch?: unknown } }).details;
      if (typeof details?.patch === "string") patch = details.patch;
    }
    if (!patch) patch = `Binary or large file changed: ${relativePath}`;
    const change: TaskFileChange = {
      id: randomUUID(),
      runId,
      callId,
      path: pending.path,
      relativePath,
      kind: pending.existed ? "modified" : "created",
      patch,
      beforeHash: pending.beforeHash,
      afterHash,
      status: "pending",
      revertible: !pending.existed || Boolean(pending.before),
    };
    this.fileChanges.set(change.id, change);
    this.changeSnapshots.set(change.id, pending.before);
    this.lastChangeRunId = runId;
    this.emit({ type: "changes.updated", runId, changes: this.listChanges(runId) });
  }

  private selectedChanges(changeIds?: string[]): TaskFileChange[] {
    const ids = changeIds ? new Set(changeIds) : undefined;
    return [...this.fileChanges.values()].filter((change) => !ids || ids.has(change.id));
  }

  private emitChangedRuns(runIds: ReadonlySet<string>): void {
    for (const runId of runIds) {
      this.persistFileChanges(runId);
      this.emit({ type: "changes.updated", runId, changes: this.listChanges(runId) });
    }
  }

  private persistFileChanges(runId: string): void {
    if (!this.session) return;
    const changes = this.listChanges(runId);
    if (changes.length === 0) return;
    this.session.sessionManager.appendCustomEntry(fileChangesEntryType, { runId, changes });
  }

  private hashBuffer(value: Buffer): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private hashFile(filePath: string): string {
    const hash = createHash("sha256");
    const descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead);
      return hash.digest("hex");
    } finally {
      fs.closeSync(descriptor);
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
    this.sessionCwd = undefined;
    this.pendingFileMutations.clear();
    this.sessionDisplayContextWindow = 0;
    this.sandboxedBashActive = false;
    this.activeRunId = undefined;
    this.running = false;
    for (const pending of this.pendingQuestions.values()) pending.resolve("会话已结束");
    this.pendingQuestions.clear();
  }
}
