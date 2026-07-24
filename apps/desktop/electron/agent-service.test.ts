import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, SaveModelSettings } from "../src/contracts.js";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  },
}));

import { AgentService } from "./agent-service.js";

type ChatRequest = { messages?: Array<Record<string, unknown>>; tools?: unknown[] };

function eventsOfType<TType extends AgentEvent["type"]>(events: AgentEvent[], type: TType): Array<Extract<AgentEvent, { type: TType }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: TType }> => event.type === type);
}

const temporaryDirectories: string[] = [];

function createDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-desktop-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSse(res: http.ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usage(input: number, output: number, cost: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("AgentService with a real Pi session", () => {
  it("exposes the complete Pi provider catalog plus every supported compatible protocol", async () => {
    const configuration: SaveModelSettings = {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-6",
      thinkingLevel: "off",
    };
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("catalog-agent"), createDirectory("catalog-workspace"), () => {});

    try {
      const catalog = await service.getModelCatalog(false);
      expect(catalog.length).toBeGreaterThan(35);
      expect(catalog).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "anthropic", kind: "builtin", supportsApiKey: true }),
        expect.objectContaining({ id: "google", kind: "builtin" }),
        expect.objectContaining({ id: "amazon-bedrock", kind: "builtin" }),
        expect.objectContaining({ id: "openrouter", kind: "builtin" }),
        expect.objectContaining({ id: "openai-compatible", kind: "compatible" }),
        expect.objectContaining({ id: "openai-responses-compatible", kind: "compatible" }),
        expect.objectContaining({ id: "anthropic-compatible", kind: "compatible" }),
        expect.objectContaining({ id: "google-compatible", kind: "compatible" }),
      ]));
      expect(catalog.find((provider) => provider.id === "openrouter")?.models.length).toBeGreaterThan(100);
    } finally {
      service.dispose();
    }
  });

  it("discovers and persists models from an OpenAI-compatible endpoint", async () => {
    let requestUrl = "";
    let authorization = "";
    const server = http.createServer((req, res) => {
      requestUrl = req.url ?? "";
      authorization = req.headers.authorization ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [
        { id: "gpt-zeta" },
        { id: "gpt-alpha", context_window: 64_000 },
        { id: "gpt-5.6-sol" },
      ] }));
    });
    const port = await listen(server);
    const agentDir = createDirectory("model-discovery-agent");
    const configuration: SaveModelSettings = {
      provider: "openai-responses-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "gpt-5",
      thinkingLevel: "off",
      apiKey: "discovery-key",
    };
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, agentDir, createDirectory("model-discovery-workspace"), () => {});

    try {
      await expect(service.discoverModels(configuration)).resolves.toEqual([
        { id: "gpt-5.6-sol", name: "gpt-5.6-sol", reasoning: true, protocol: "openai-responses", contextWindow: 1_050_000 },
        { id: "gpt-alpha", name: "gpt-alpha", reasoning: true, protocol: "openai-responses", contextWindow: 64_000 },
        { id: "gpt-zeta", name: "gpt-zeta", reasoning: true, protocol: "openai-responses", contextWindow: 0 },
      ]);
      expect(requestUrl).toBe("/v1/models");
      expect(authorization).toBe("Bearer discovery-key");
      const catalog = await service.getModelCatalog(false);
      const compatibleModels = catalog.find((provider) => provider.id === "openai-responses-compatible")?.models;
      expect(compatibleModels?.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-alpha", "gpt-zeta"]);
      expect(compatibleModels?.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
        protocol: "openai-responses",
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        metadataSource: "official",
      });
      expect(fs.existsSync(path.join(agentDir, "discovered-models.json"))).toBe(true);
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("validates a saved model configuration through a real provider request", async () => {
    let requestUrl = "";
    let authorization = "";
    const server = http.createServer((req, res) => {
      requestUrl = req.url ?? "";
      authorization = req.headers.authorization ?? "";
      req.resume();
      req.on("end", () => writeSse(res, [
        chunk({ role: "assistant" }),
        chunk({ content: "PI_CONNECTION_OK" }),
        chunk({}, "stop"),
      ]));
    });
    const port = await listen(server);
    const cwd = createDirectory("connection-workspace");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "connection-key",
    };
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("connection-agent"), cwd, () => {});

    try {
      await expect(service.testConfiguration(configuration)).resolves.toBe("PI_CONNECTION_OK");
      expect(requestUrl).toBe("/v1/chat/completions");
      expect(authorization).toBe("Bearer connection-key");
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("persists, lists, reloads, and continues conversations from the local session directory", async () => {
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        writeSse(res, [
          chunk({ role: "assistant" }),
          chunk({ content: requests.length === 1 ? "persisted-answer" : "continued-answer" }),
          chunk({}, "stop"),
        ]);
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("persistent-conversation-workspace");
    const agentDir = createDirectory("persistent-conversation-agent");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "persistent-key",
    };
    const settings = { resolve: () => ({ ...configuration }) };
    const firstEvents: AgentEvent[] = [];
    const firstService = new AgentService(settings, agentDir, cwd, (event) => firstEvents.push(event));
    const conversationId = "persistent-conversation";

    try {
      const firstRun = await firstService.send("remember this", cwd, conversationId);
      await vi.waitFor(() => expect(firstEvents.some((event) => event.type === "run.completed" && event.runId === firstRun)).toBe(true), { timeout: 8_000 });
      firstService.dispose();

      const secondEvents: AgentEvent[] = [];
      const secondService = new AgentService(settings, agentDir, cwd, (event) => secondEvents.push(event));
      try {
        const conversations = await secondService.listConversations();
        expect(conversations).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversationId, title: "remember this" })]));
        await expect(secondService.loadConversation(conversationId)).resolves.toEqual(expect.objectContaining({
          id: conversationId,
          turns: [expect.objectContaining({ question: "remember this", answer: "persisted-answer" })],
        }));

        const secondRun = await secondService.send("what did I say?", cwd, conversationId);
        await vi.waitFor(() => expect(secondEvents.some((event) => event.type === "run.completed" && event.runId === secondRun)).toBe(true), { timeout: 8_000 });
        expect(requests[1].messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "assistant", content: "persisted-answer" }),
          expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "what did I say?" })]) }),
        ]));
      } finally {
        secondService.dispose();
      }
    } finally {
      firstService.dispose();
      await close(server);
    }
  });

  it("restores historical thinking, tool calls, per-answer model usage, and context", async () => {
    const cwd = createDirectory("usage-history-workspace");
    const agentDir = createDirectory("usage-history-agent");
    const sessionDir = createDirectory("usage-history-sessions");
    const conversationId = "usage-history";
    const manager = SessionManager.create(cwd, sessionDir, { id: conversationId });
    manager.appendMessage({ role: "user", content: "inspect the project", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should inspect the files" },
        { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
      ],
      api: "openai-completions",
      provider: "openai-compatible",
      model: "gpt-5.6-sol",
      usage: usage(100, 10, 0.01),
      stopReason: "toolUse",
      timestamp: 2,
    } satisfies AssistantMessage);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "project readme" }],
      isError: false,
      timestamp: 3,
    } satisfies ToolResultMessage);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "historical answer" }],
      api: "openai-completions",
      provider: "openai-compatible",
      model: "gpt-5.6-sol",
      responseModel: "mock-model-2026-07",
      usage: usage(160, 20, 0.02),
      stopReason: "stop",
      timestamp: 4,
    } satisfies AssistantMessage);

    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "off",
    };
    const service = new AgentService(
      { resolve: () => ({ ...configuration }) },
      agentDir,
      cwd,
      () => {},
      undefined,
      undefined,
      sessionDir,
    );

    try {
      await expect(service.loadConversation(conversationId)).resolves.toMatchObject({
        id: conversationId,
        contextUsage: { tokens: 180, contextWindow: 1_050_000 },
        turns: [{
          question: "inspect the project",
          answer: "historical answer",
          usage: {
            provider: "openai-compatible",
            model: "gpt-5.6-sol",
            responseModel: "mock-model-2026-07",
            inputTokens: 160,
            outputTokens: 20,
            totalTokens: 180,
            requestCount: 2,
            cost: 0.03,
          },
          activities: [
            expect.objectContaining({ type: "thinking", text: "I should inspect the files" }),
            expect.objectContaining({ type: "tool", name: "read", output: "project readme", status: "success" }),
            expect.objectContaining({ type: "message", text: "historical answer" }),
          ],
        }],
      });
    } finally {
      service.dispose();
    }
  });

  it("renames and deletes a persisted conversation by id", async () => {
    const cwd = createDirectory("conversation-mutation-workspace");
    const agentDir = createDirectory("conversation-mutation-agent");
    const sessionDir = createDirectory("conversation-mutation-sessions");
    const manager = SessionManager.create(cwd, sessionDir, { id: "conversation-to-mutate" });
    manager.appendMessage({ role: "user", content: "original title", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "saved" }],
      api: "openai-completions",
      provider: "openai-compatible",
      model: "mock-model",
      usage: usage(1, 1, 0),
      stopReason: "stop",
      timestamp: 2,
    } satisfies AssistantMessage);
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "mock-model",
      thinkingLevel: "off",
    };
    const service = new AgentService(
      { resolve: () => ({ ...configuration }) },
      agentDir,
      cwd,
      () => {},
      undefined,
      undefined,
      sessionDir,
    );

    try {
      await expect(service.listConversations()).resolves.toEqual([
        expect.objectContaining({ id: "conversation-to-mutate", title: "original title" }),
      ]);
      await service.renameConversation("conversation-to-mutate", "Renamed conversation");
      await expect(service.listConversations()).resolves.toEqual([
        expect.objectContaining({ id: "conversation-to-mutate", title: "Renamed conversation" }),
      ]);
      await service.deleteConversation("conversation-to-mutate");
      await expect(service.listConversations()).resolves.toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("activates a third-party extension tool as the subagent provider", async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => writeSse(res, [
        chunk({ role: "assistant" }),
        chunk({ content: "ready" }),
        chunk({}, "stop"),
      ]));
    });
    const port = await listen(server);
    const cwd = createDirectory("plugin-provider-workspace");
    const agentDir = createDirectory("plugin-provider-agent");
    const extensionDirectory = path.join(agentDir, "extensions");
    fs.mkdirSync(extensionDirectory, { recursive: true });
    fs.writeFileSync(path.join(extensionDirectory, "community-subagent.js"), `
      export default function (pi) {
        pi.registerTool({
          name: "community_subagent",
          label: "Community subagent",
          description: "Delegate work through a community extension.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({ content: [{ type: "text", text: "community-result" }] })
        });
      }
    `);
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "plugin-provider-key",
    };
    const capabilities = { get: () => ({
      subagent: { kind: "plugin" as const, source: "auto", toolName: "community_subagent" },
      memory: { kind: "none" as const },
      learning: { kind: "none" as const },
      subagentHistory: [],
      memoryHistory: [],
      learningHistory: [],
    }) };
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, agentDir, cwd, () => {}, undefined, capabilities);

    try {
      await service.send("initialize plugin runtime", cwd);
      await vi.waitFor(() => expect(service.isRunning()).toBe(false), { timeout: 8_000 });

      const runtime = service.getPluginRuntime();
      expect(runtime.effectiveSubagent).toEqual({ kind: "plugin", source: "auto", toolName: "community_subagent" });
      expect(runtime.fallbackReason).toBeUndefined();
      expect(runtime.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "community_subagent", active: true }),
        expect.objectContaining({ name: "pi_desktop_subagent", active: false, sourceKind: "desktop" }),
      ]));
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("streams text, executes ask_user, captures every emitted SDK event, and preserves multi-turn history", async () => {
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        if (requests.length === 1) {
          writeSse(res, [
            chunk({ role: "assistant" }),
            chunk({
              tool_calls: [{
                index: 0,
                id: "call-question",
                type: "function",
                function: {
                  name: "ask_user",
                  arguments: JSON.stringify({
                    question: "Choose a path",
                    options: [{ label: "Approved", description: "Continue the test" }],
                  }),
                },
              }],
            }),
            chunk({}, "tool_calls"),
          ]);
        } else {
          const answer = requests.length === 2 ? "first-answer" : "second-answer";
          const reasoning = requests.length === 2 ? "analysis-first" : "analysis-second";
          writeSse(res, [chunk({ role: "assistant" }), chunk({ reasoning_content: reasoning }), chunk({ content: answer }), chunk({}, "stop")]);
        }
      });
    });

    const port = await listen(server);
    const cwd = createDirectory("workspace");
    const agentDir = createDirectory("agent");
    const events: AgentEvent[] = [];
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "gpt-5.6-sol",
      thinkingLevel: "off",
      apiKey: "local-test-key",
    };
    const settings = { resolve: () => ({ ...configuration }) };
    let service: AgentService;
    service = new AgentService(settings, agentDir, cwd, (event) => {
      events.push(event);
      if (event.type === "question.requested") service.answerQuestion(event.callId, "Approved");
    });

    try {
      const first = await service.send("first prompt", cwd);
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === first)).toBe(true), { timeout: 8_000 });

      expect(eventsOfType(events, "message.delta").filter((event) => event.runId === first).map((event) => event.text).join("")).toBe("first-answer");
      expect(eventsOfType(events, "thinking.delta").filter((event) => event.runId === first).map((event) => event.text).join("")).toBe("analysis-first");
      expect(events.some((event) => event.type === "question.requested" && event.question === "Choose a path")).toBe(true);
      expect(events.some((event) => event.type === "tool.started" && event.name === "ask_user")).toBe(true);
      expect(events.some((event) => event.type === "tool.completed" && event.name === "ask_user" && !event.isError)).toBe(true);
      expect(eventsOfType(events, "response.usage").filter((event) => event.runId === first)).toEqual(expect.arrayContaining([
        expect.objectContaining({ usage: expect.objectContaining({ provider: "openai-compatible", model: "gpt-5.6-sol", requestCount: 1 }) }),
      ]));
      expect(eventsOfType(events, "context.updated").filter((event) => event.runId === first)).toEqual(expect.arrayContaining([
        expect.objectContaining({ usage: expect.objectContaining({ contextWindow: 1_050_000 }) }),
      ]));

      const trace = eventsOfType(events, "agent.event").filter((event) => event.runId === first).map((event) => event.event);
      const eventTypes = new Set(trace.map((event) => event.eventType));
      expect([...eventTypes]).toEqual(expect.arrayContaining([
        "agent_start",
        "agent_end",
        "agent_settled",
        "turn_start",
        "turn_end",
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
      ]));
      expect(trace.map((event) => event.sequence)).toEqual(trace.map((_event, index) => index + 1));

      const assistantSubtypes = trace
        .filter((event) => event.eventType === "message_update")
        .map((event) => (event.payload as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type);
      expect(assistantSubtypes).toEqual(expect.arrayContaining([
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end",
      ]));

      expect(requests).toHaveLength(2);
      expect(requests[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "ask_user" }) })]));
      expect(requests[1].messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: expect.stringContaining("User answered: Approved") }),
      ]));

      const second = await service.send("second prompt", cwd);
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === second)).toBe(true), { timeout: 8_000 });
      expect(eventsOfType(events, "message.delta").filter((event) => event.runId === second).map((event) => event.text).join("")).toBe("second-answer");
      expect(requests).toHaveLength(3);
      expect(requests[2].messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "first-answer" }),
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([expect.objectContaining({ type: "text", text: "second prompt" })]),
        }),
      ]));
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("runs a delegated subagent and streams its progress back through the parent tool", async () => {
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        if (requests.length === 1) {
          writeSse(res, [
            chunk({ role: "assistant" }),
            chunk({
              tool_calls: [{
                index: 0,
                id: "call-subagent",
                type: "function",
                function: {
                  name: "pi_desktop_subagent",
                  arguments: JSON.stringify({ role: "reviewer", task: "Inspect the focused change" }),
                },
              }],
            }),
            chunk({}, "tool_calls"),
          ]);
        } else if (requests.length === 2) {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "child-report" }), chunk({}, "stop")]);
        } else {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "parent-answer" }), chunk({}, "stop")]);
        }
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("subagent-workspace");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "subagent-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("subagent-agent"), cwd, (event) => events.push(event));

    try {
      const runId = await service.send("delegate this review", cwd);
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });

      expect(eventsOfType(events, "message.delta").filter((event) => event.runId === runId).map((event) => event.text).join("")).toBe("parent-answer");
      expect(events.some((event) => event.type === "tool.started" && event.name === "pi_desktop_subagent")).toBe(true);
      expect(events.some((event) => event.type === "tool.updated" && event.name === "pi_desktop_subagent" && event.output.includes("child-report"))).toBe(true);
      expect(events.some((event) => event.type === "tool.completed" && event.name === "pi_desktop_subagent" && event.output.includes("child-report"))).toBe(true);
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[1].messages)).toContain("You are the reviewer subagent");
      expect(requests[2].messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: expect.stringContaining("child-report") }),
      ]));
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("aborts an in-flight provider request and emits run.stopped without a false completion", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      requestStarted();
    });
    const port = await listen(server);
    const cwd = createDirectory("abort-workspace");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "abort-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("abort-agent"), cwd, (event) => events.push(event));

    try {
      const runId = await service.send("wait forever", cwd);
      await started;
      await service.abort();
      expect(events.some((event) => event.type === "run.stopped" && event.runId === runId)).toBe(true);
      expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(false);
      expect(eventsOfType(events, "agent.event").filter((event) => event.runId === runId).map((event) => event.event.eventType)).toContain("agent_settled");
    } finally {
      service.dispose();
      await close(server);
    }
  });
});
