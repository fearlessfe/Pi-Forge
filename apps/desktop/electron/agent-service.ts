import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, QuestionOption, SaveModelSettings } from "../src/contracts.js";
import { captureAgentSessionEvent } from "./agent-event-adapter.js";
import { SettingsStore } from "./settings-store.js";

type EventSink = (event: AgentEvent) => void;

type PendingQuestion = {
  resolve: (answer: string) => void;
};

type RuntimeConfig = ReturnType<SettingsStore["resolve"]>;

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

  constructor(
    private readonly settings: Pick<SettingsStore, "resolve">,
    private readonly agentDir: string,
    private readonly fallbackCwd: string,
    private readonly emit: EventSink,
  ) {}

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
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user", "spawn_subagent"],
      customTools,
      sessionManager: SessionManager.inMemory(cwd),
    });

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
      name: "spawn_subagent",
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

  private async createModelRuntime(config: RuntimeConfig) {
    const provider = config.provider === "openai-compatible" ? "pi-desktop-openai-compatible" : config.provider;
    const api: Api = config.provider === "anthropic"
      ? "anthropic-messages"
      : config.provider === "openai"
        ? "openai-responses"
        : "openai-completions";
    const apiKey = config.apiKey || (config.provider === "openai-compatible" ? "local" : undefined);
    if (!apiKey) throw new Error("尚未配置 API Key，请先在设置中保存模型配置。");
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey(provider, apiKey);
    modelRuntime.registerProvider(provider, {
      name: config.provider === "openai-compatible" ? "OpenAI Compatible" : config.provider,
      baseUrl: config.baseUrl,
      api,
      authHeader: config.provider !== "anthropic",
      models: [{
        id: config.modelId,
        name: config.modelId,
        api,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_000,
        compat: config.provider === "openai-compatible" ? {
          supportsDeveloperRole: false,
          supportsReasoningEffort: config.thinkingLevel !== "off",
        } : undefined,
      }],
    });
    const model = modelRuntime.getModel(provider, config.modelId) as Model<Api> | undefined;
    if (!model) throw new Error(`找不到模型 ${config.modelId}。`);
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
