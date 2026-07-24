import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type LoadExtensionsResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type CredentialStore, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CapabilitySettings,
  PluginRuntimeStatus,
  ProviderCatalogEntry,
  QuestionOption,
  RuntimeTool,
  SaveModelSettings,
} from "../src/contracts.js";
import { captureAgentSessionEvent } from "./agent-event-adapter.js";
import { SettingsStore } from "./settings-store.js";

type EventSink = (event: AgentEvent) => void;

type PendingQuestion = {
  resolve: (answer: string) => void;
};

type RuntimeConfig = ReturnType<SettingsStore["resolve"]>;

type CapabilitySettingsReader = Pick<{ get(): CapabilitySettings }, "get">;

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

function isInsideWorkspace(cwd: string, candidate: string): boolean {
  const root = fs.realpathSync(cwd);
  const absolute = path.resolve(cwd, candidate);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const resolvedExisting = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  const resolved = path.resolve(resolvedExisting, path.relative(existing, absolute));
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class AgentService {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private sessionKey?: string;
  private activeRunId?: string;
  private pendingQuestions = new Map<string, PendingQuestion>();
  private running = false;
  private eventSequence = 0;
  private appliedSubagentTool?: string;
  private capabilityFallbackReason?: string;

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
  ) {}

  async getModelCatalog(): Promise<ProviderCatalogEntry[]> {
    const runtime = await ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: path.join(this.agentDir, "models.json"),
      modelsStorePath: path.join(this.agentDir, "models-store.json"),
      allowModelNetwork: false,
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
      })),
    }));
    const compatible = Object.entries(compatibleProviderDefinitions).map(([id, definition]): ProviderCatalogEntry => ({
      id,
      name: definition.name,
      baseUrl: definition.baseUrl,
      kind: "compatible",
      supportsApiKey: true,
      supportsOAuth: false,
      models: [{ id: definition.defaultModel, name: definition.defaultModel, reasoning: true }],
    }));
    return [...builtins, ...compatible];
  }

  async send(prompt: string, cwd?: string): Promise<string> {
    if (this.running) throw new Error("Agent 正在执行，请先停止当前任务或等待完成。");
    if (!prompt.trim()) throw new Error("消息不能为空。");

    const resolvedCwd = this.resolveCwd(cwd);
    const config = this.settings.resolve();
    const session = await this.ensureSession(resolvedCwd, config);
    const runId = randomUUID();
    this.activeRunId = runId;
    this.running = true;
    this.eventSequence = 0;
    this.emit({ type: "run.started", runId });

    void session.prompt(prompt.trim()).then(() => {
      if (this.activeRunId !== runId) return;
      const modelError = session.agent.state.errorMessage;
      this.activeRunId = undefined;
      this.running = false;
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
  }

  private async ensureSession(cwd: string, config: RuntimeConfig): Promise<AgentSession> {
    const key = JSON.stringify([cwd, config.provider, config.baseUrl, config.modelId, config.thinkingLevel, config.apiKey]);
    if (this.session && this.sessionKey === key) return this.session;
    this.disposeSession();

    const runtime = await this.createModelRuntime(config);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", async (event) => {
            if (!this.activeRunId) return undefined;
            const input = event.input as Record<string, unknown>;
            const candidatePath = typeof input.path === "string" ? input.path : undefined;
            const outsideWorkspace = candidatePath ? !isInsideWorkspace(cwd, candidatePath) : false;
            const sensitiveTool = ["bash", "edit", "write"].includes(event.toolName);
            if (!outsideWorkspace && !sensitiveTool) return undefined;
            const summary = resultText(event.input);
            const answer = await this.requestUser(
              event.toolCallId,
              outsideWorkspace
                ? `${event.toolName} 将访问所选工作目录之外的路径，是否允许本次访问？\n${summary}`
                : `${event.toolName} 将执行可能修改系统或工作区的操作，是否允许？\n${summary}`,
              [
                { label: "允许一次", description: "仅允许当前这次工具调用" },
                { label: "拒绝", description: "阻止本次调用并让 Agent 调整方案" },
              ],
            );
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
      sessionManager: SessionManager.inMemory(cwd),
    });

    this.applyToolPolicy(session);
    this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
    this.session = session;
    this.sessionKey = key;
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
              if (typeof input.path === "string" && !isInsideWorkspace(cwd, input.path)) {
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

    if (compatible) {
      const endpoint = new URL(config.baseUrl);
      const isLocal = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
      const apiKey = config.apiKey || (isLocal ? "local" : undefined);
      if (apiKey) await modelRuntime.setRuntimeApiKey(config.provider, apiKey, { allowNetwork: false });
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 32_000,
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
    return { modelRuntime, model, thinkingLevel: config.thinkingLevel };
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
    fs.mkdirSync(this.fallbackCwd, { recursive: true });
    return this.fallbackCwd;
  }

  private disposeSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.sessionKey = undefined;
    this.activeRunId = undefined;
    this.running = false;
    for (const pending of this.pendingQuestions.values()) pending.resolve("会话已结束");
    this.pendingQuestions.clear();
  }
}
