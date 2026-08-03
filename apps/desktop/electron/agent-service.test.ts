import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AssistantMessage, type ToolResultMessage, type Usage, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, SaveModelSettings } from "../src/contracts.js";
import { planReviewBlocks } from "../src/plan-review.js";

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("discovers Google and Anthropic model payload variants with provider-specific authentication", async () => {
    const agentDir = createDirectory("multi-protocol-discovery-agent");
    const workspace = createDirectory("multi-protocol-discovery-workspace");
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("google-compatible", async () => ({ type: "api_key", key: "stored-google-key" }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [
        "models/gemini-string",
        { name: "models/gemini-display", displayName: "Gemini Display", max_context_length: 32_000 },
        { name: "models/gemini-display", displayName: "Duplicate" },
        { id: " ", displayName: "Missing id" },
        null,
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: "claude-custom", display_name: "Claude Custom", contextWindow: 48_000 },
        { name: "claude-name", context_window: -1 },
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new AgentService(
      { resolve: () => ({ provider: "google-compatible", baseUrl: "https://generativelanguage.example/v1beta", modelId: "gemini-display", thinkingLevel: "off" }) },
      agentDir,
      workspace,
      () => {},
      credentials,
    );

    try {
      const google = await service.discoverModels({
        provider: "google-compatible",
        baseUrl: "https://generativelanguage.example/v1beta/?ignored=yes#fragment",
        modelId: "gemini-display",
        thinkingLevel: "off",
      });
      expect(google).toEqual([
        expect.objectContaining({ id: "gemini-display", name: "Duplicate", contextWindow: 0 }),
        expect.objectContaining({ id: "gemini-string", name: "gemini-string" }),
      ]);
      const [googleUrl, googleRequest] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(googleUrl.toString()).toBe("https://generativelanguage.example/v1beta/models");
      expect(googleRequest.headers).toMatchObject({ "x-goog-api-key": "stored-google-key" });

      const anthropic = await service.discoverModels({
        provider: "anthropic-compatible",
        baseUrl: "https://anthropic.example/api",
        modelId: "claude-custom",
        thinkingLevel: "off",
        apiKey: " anthropic-key ",
      });
      expect(anthropic).toEqual([
        expect.objectContaining({ id: "claude-custom", name: "Claude Custom", contextWindow: 48_000 }),
        expect.objectContaining({ id: "claude-name", name: "claude-name", contextWindow: 0 }),
      ]);
      const [anthropicUrl, anthropicRequest] = fetchMock.mock.calls[1] as [URL, RequestInit];
      expect(anthropicUrl.toString()).toBe("https://anthropic.example/api/v1/models");
      expect(anthropicRequest.headers).toMatchObject({ "x-api-key": "anthropic-key", "anthropic-version": "2023-06-01" });
    } finally {
      service.dispose();
    }
  });

  it("reports actionable model discovery failures without persisting bad responses", async () => {
    const agentDir = createDirectory("discovery-errors-agent");
    const workspace = createDirectory("discovery-errors-workspace");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: "https://models.example/v1",
      modelId: "model",
      thinkingLevel: "off",
    };
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, agentDir, workspace, () => {});
    const abortError = new Error("request aborted");
    abortError.name = "AbortError";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce("socket closed")
      .mockResolvedValueOnce(new Response("denied", { status: 401 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "x".repeat(10_000_001) } as Response);
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(service.discoverModels({ ...configuration, baseUrl: "not a URL" })).rejects.toThrow("有效的 API 地址");
      await expect(service.discoverModels(configuration)).rejects.toThrow("获取模型超时");
      await expect(service.discoverModels(configuration)).rejects.toThrow("无法连接模型端点：socket closed");
      await expect(service.discoverModels(configuration)).rejects.toThrow("HTTP 401");
      await expect(service.discoverModels(configuration)).rejects.toThrow("有效的 JSON");
      await expect(service.discoverModels(configuration)).rejects.toThrow("没有找到任何模型");
      await expect(service.discoverModels(configuration)).rejects.toThrow("响应过大");
      await expect(service.discoverModels({ ...configuration, provider: "missing-provider" })).rejects.toThrow("不存在 provider");
      await expect(service.discoverModels({ ...configuration, provider: "anthropic" })).resolves.toEqual(expect.any(Array));
      expect(fs.existsSync(path.join(agentDir, "discovered-models.json"))).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it("migrates trustworthy discovered-model metadata and ignores corrupted cache entries", async () => {
    const agentDir = createDirectory("discovery-cache-agent");
    fs.writeFileSync(path.join(agentDir, "discovered-models.json"), JSON.stringify({
      version: 1,
      providers: {
        "openai-compatible": {
          baseUrl: 123,
          updatedAt: null,
          models: [
            { id: "unknown-model", name: "Unknown", reasoning: true, contextWindow: 128_000 },
            { id: "gpt-5.6-sol", name: "GPT", reasoning: true, contextWindow: 128_000 },
            { id: 3, name: "Invalid", reasoning: true },
          ],
        },
        invalid: null,
      },
    }));
    const service = new AgentService(
      { resolve: () => ({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", modelId: "unknown-model", thinkingLevel: "off" }) },
      agentDir,
      createDirectory("discovery-cache-workspace"),
      () => {},
    );

    try {
      const models = (await service.getModelCatalog(false)).find((provider) => provider.id === "openai-compatible")?.models ?? [];
      expect(models.find((model) => model.id === "unknown-model")?.contextWindow).toBe(0);
      expect(models.find((model) => model.id === "gpt-5.6-sol")?.contextWindow).toBe(1_050_000);
      fs.writeFileSync(path.join(agentDir, "discovered-models.json"), "corrupted");
      await expect(service.getModelCatalog(false)).resolves.toEqual(expect.any(Array));
    } finally {
      service.dispose();
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

  it("expands /init into an AGENTS.md initialization task while keeping the command in conversation history", async () => {
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "initialized" }), chunk({}, "stop")]);
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("init-command-workspace");
    const agentDir = createDirectory("init-command-agent");
    const events: AgentEvent[] = [];
    const service = new AgentService({
      resolve: () => ({
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: "mock-model",
        thinkingLevel: "off" as const,
        apiKey: "init-key",
      }),
    }, agentDir, cwd, (event) => events.push(event));

    try {
      const runId = await service.send("/init", cwd, "init-conversation");
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });

      expect(JSON.stringify(requests[0]?.messages)).toContain("creating or updating AGENTS.md");
      await expect(service.loadConversation("init-conversation")).resolves.toEqual(expect.objectContaining({
        title: "/init",
        turns: [expect.objectContaining({ question: "/init", answer: "initialized" })],
      }));
    } finally {
      service.dispose();
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

  it("supports full-text metadata, archive, tags, exports, and selected-turn forks", async () => {
    const cwd = createDirectory("conversation-features-workspace");
    const agentDir = createDirectory("conversation-features-agent");
    const sessionDir = createDirectory("conversation-features-sessions");
    const manager = SessionManager.create(cwd, sessionDir, { id: "conversation-features" });
    const firstTurnId = manager.appendMessage({ role: "user", content: "find the hidden phrase", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "needle-in-the-history" }],
      api: "openai-completions",
      provider: "openai-compatible",
      model: "mock-model",
      usage: usage(1, 1, 0),
      stopReason: "stop",
      timestamp: 2,
    } satisfies AssistantMessage);
    manager.appendMessage({ role: "user", content: "second question", timestamp: 3 } satisfies UserMessage);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second answer" }],
      api: "openai-completions",
      provider: "openai-compatible",
      model: "mock-model",
      usage: usage(1, 1, 0),
      stopReason: "stop",
      timestamp: 4,
    } satisfies AssistantMessage);
    const service = new AgentService(
      { resolve: () => ({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", modelId: "mock-model", thinkingLevel: "off" }) },
      agentDir,
      cwd,
      () => {},
      undefined,
      undefined,
      sessionDir,
    );

    try {
      await service.setConversationTags("conversation-features", ["research", "important"]);
      await service.setConversationArchived("conversation-features", true);
      const items = await service.listConversations();
      expect(items[0]).toEqual(expect.objectContaining({
        tags: ["research", "important"],
        archived: true,
        searchText: expect.stringContaining("needle-in-the-history"),
      }));

      const markdown = await service.exportConversation("conversation-features", "markdown");
      expect(markdown).toMatchObject({ mimeType: "text/markdown", filename: expect.stringMatching(/\.md$/) });
      expect(markdown.content).toContain("needle-in-the-history");
      const json = await service.exportConversation("conversation-features", "json");
      expect(JSON.parse(json.content)).toEqual(expect.objectContaining({ id: "conversation-features", archived: true }));

      const fork = await service.forkConversation("conversation-features", firstTurnId);
      expect(fork).toEqual(expect.objectContaining({ parentConversationId: "conversation-features", archived: false, tags: ["research", "important"] }));
      const forkDetail = await service.loadConversation(fork.id);
      expect(forkDetail.turns).toHaveLength(1);
      expect(forkDetail.turns[0]).toMatchObject({ question: "find the hidden phrase", answer: "needle-in-the-history" });
    } finally {
      service.dispose();
    }
  });

  it("enforces idle-state and conversation-management boundaries", async () => {
    const cwd = createDirectory("public-contract-workspace");
    const agentDir = createDirectory("public-contract-agent");
    const sessionDir = createDirectory("public-contract-sessions");
    const manager = SessionManager.create(cwd, sessionDir, { id: "contract-conversation" });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "contract question" }, { type: "image", data: "ignored", mimeType: "image/png" }] as UserMessage["content"], timestamp: 1 } satisfies UserMessage);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "contract answer" }],
      api: "openai-completions",
      provider: "openai-compatible",
      model: "mock-model",
      usage: usage(1, 1, 0),
      stopReason: "stop",
      timestamp: 2,
    } satisfies AssistantMessage);
    const service = new AgentService(
      { resolve: () => ({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", modelId: "mock-model", thinkingLevel: "off" }) },
      agentDir,
      cwd,
      () => {},
      undefined,
      undefined,
      sessionDir,
    );

    try {
      await expect(service.loadConversation("missing")).rejects.toThrow("找不到该会话");
      await expect(service.renameConversation("contract-conversation", "   ")).rejects.toThrow("不能为空");
      await expect(service.renameConversation("contract-conversation", "x".repeat(61))).rejects.toThrow("不能超过 60");
      await expect(service.renameConversation("missing", "Valid")).rejects.toThrow("找不到该会话");
      await expect(service.deleteConversation("missing")).rejects.toThrow("找不到该会话");
      await expect(service.setConversationTags("contract-conversation", Array.from({ length: 9 }, (_, index) => `tag-${index}`))).rejects.toThrow("最多设置 8 个标签");
      await expect(service.setConversationTags("contract-conversation", ["x".repeat(25)])).rejects.toThrow("不超过 24");
      await expect(service.forkConversation("contract-conversation", "missing-entry")).rejects.toThrow("节点不存在");
      const fork = await service.forkConversation("contract-conversation");
      expect(fork.parentConversationId).toBe("contract-conversation");

      expect(await service.executeExtensionCommand("not a command", cwd)).toBe(false);
      await expect(service.queueMessage("later", "steer")).rejects.toThrow("没有正在运行");
      expect(service.clearQueue()).toEqual({ steering: [], followUp: [] });
      expect(service.listChanges()).toEqual([]);
      expect(service.acceptChanges()).toEqual([]);
      expect(service.revertChanges()).toEqual([]);
      expect(service.getPermissionRuntime()).toMatchObject({ platform: process.platform, sandbox: expect.stringMatching(/available|unavailable/) });
      expect(service.getPluginRuntime()).toMatchObject({ hasSession: false, effectiveSubagent: { kind: "pending" } });
      expect(await service.reloadPackages()).toBe(false);
      expect(service.refreshCapabilities()).toMatchObject({ hasSession: false });
      expect(() => service.answerQuestion("missing", "answer")).toThrow("已失效");
      await service.abort();

      const inventory = await service.getResourceInventory(cwd);
      expect(inventory).toMatchObject({ cwd: path.resolve(cwd), commands: expect.any(Array), skills: expect.any(Array) });
      await expect(service.getResourceInventory(path.join(cwd, "missing"))).rejects.toThrow("工作目录不存在");
      service.reset();
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
      await expect(service.reloadPackages()).resolves.toBe(true);
      expect(service.getPluginRuntime().effectiveSubagent).toEqual({ kind: "plugin", source: "auto", toolName: "community_subagent" });
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
      expect(requests[0].tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "ask_user" }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: "request_plan_review" }) }),
      ]));
      expect(requests[1].messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: expect.stringContaining("User answered: Approved") }),
      ]));
      await vi.waitFor(async () => {
        const budget = await service.getContextBudget(cwd);
        expect(budget.history[0]).toMatchObject({
          conversationId: expect.any(String),
          runId: first,
          actualInputTokens: expect.any(Number),
          estimatedResourceTokens: expect.any(Number),
        });
      });

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

  it("waits for a versioned native plan review and returns anchored feedback to the model", async () => {
    const requests: ChatRequest[] = [];
    const markdown = "# Migration\n\n1. Update the contract\n2. Add tests";
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        if (requests.length === 1) {
          writeSse(res, [
            chunk({ role: "assistant" }),
            chunk({ tool_calls: [{ index: 0, id: "call-plan", type: "function", function: { name: "request_plan_review", arguments: JSON.stringify({ title: "Migration", markdown }) } }] }),
            chunk({}, "tool_calls"),
          ]);
        } else {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "I will revise the plan." }), chunk({}, "stop")]);
        }
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("plan-review-workspace");
    const agentDir = createDirectory("plan-review-agent");
    const events: AgentEvent[] = [];
    let service: AgentService;
    service = new AgentService({ resolve: () => ({ provider: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "gpt-5", thinkingLevel: "off", apiKey: "local" }) }, agentDir, cwd, (event) => {
      events.push(event);
      if (event.type === "plan.review.requested") {
        service.resolvePlanReview({ reviewId: event.review.id, versionId: event.review.activeVersionId, decision: "changes_requested", annotations: [{ anchorId: planReviewBlocks(markdown)[1].id, quote: "ignored", comment: "Add a rollback step." }] });
      }
    });

    try {
      const runId = await service.send("Prepare a migration plan", cwd);
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });
      expect(events.some((event) => event.type === "plan.review.requested")).toBe(true);
      expect(events.some((event) => event.type === "plan.review.resolved" && event.review.status === "changes_requested")).toBe(true);
      expect(requests[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", content: expect.stringContaining("Add a rollback step") })]));
      expect(service.listPlanReviews()[0]).toMatchObject({ title: "Migration", status: "changes_requested", versions: [expect.objectContaining({ number: 1, decision: "changes_requested" })] });
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
          writeSse(res, [
            chunk({ role: "assistant" }),
            chunk({ tool_calls: [{ index: 0, id: "call-child-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) } }] }),
            chunk({}, "tool_calls"),
          ]);
        } else if (requests.length === 3) {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "child-report" }), chunk({}, "stop")]);
        } else {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "parent-answer" }), chunk({}, "stop")]);
        }
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("subagent-workspace");
    fs.writeFileSync(path.join(cwd, "README.md"), "subagent fixture\n", "utf8");
    const agentDir = createDirectory("subagent-agent");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "subagent-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, agentDir, cwd, (event) => events.push(event));

    try {
      const runId = await service.send("delegate this review", cwd);
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });

      expect(eventsOfType(events, "message.delta").filter((event) => event.runId === runId).map((event) => event.text).join("")).toBe("parent-answer");
      expect(events.some((event) => event.type === "tool.started" && event.name === "pi_desktop_subagent")).toBe(true);
      expect(events.some((event) => event.type === "tool.updated" && event.name === "pi_desktop_subagent" && event.output.includes("child-report"))).toBe(true);
      const completed = eventsOfType(events, "tool.completed").find((event) => event.name === "pi_desktop_subagent");
      expect(completed).toMatchObject({
        output: expect.stringContaining("child-report"),
        details: { subagent: { role: "reviewer", status: "completed", usage: { requestCount: 2 } } },
      });
      expect(requests).toHaveLength(4);
      expect(JSON.stringify(requests[1].messages)).toContain("You are the reviewer subagent");
      expect(requests[3].messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: expect.stringContaining("child-report") }),
      ]));

      const subagentDirectory = path.join(agentDir, "sessions", "subagents");
      const childSessions = await SessionManager.listAll(subagentDirectory);
      expect(childSessions).toEqual([expect.objectContaining({ id: completed?.details?.subagent?.sessionId })]);
      const conversations = await service.listConversations();
      expect(conversations).toHaveLength(1);
      expect(conversations[0].id).not.toBe(completed?.details?.subagent?.sessionId);
      const restored = await service.loadConversation(conversations[0].id);
      expect(restored.turns[0].activities).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "call-subagent",
          details: expect.objectContaining({
            subagent: expect.objectContaining({
              sessionId: completed?.details?.subagent?.sessionId,
              usage: expect.objectContaining({ requestCount: 2 }),
            }),
          }),
        }),
      ]));
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("captures task file diffs and only reverts files that still match the Agent result", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requestCount += 1;
        if (requestCount === 1) {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ tool_calls: [{ index: 0, id: "call-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "created.txt", content: "created by agent\n" }) } }] }), chunk({}, "tool_calls")]);
        } else if (requestCount === 2) {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ tool_calls: [{ index: 0, id: "call-edit", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: "existing.txt", edits: [{ oldText: "before\n", newText: "after\n" }] }) } }] }), chunk({}, "tool_calls")]);
        } else {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "files updated" }), chunk({}, "stop")]);
        }
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("changes-workspace");
    fs.writeFileSync(path.join(cwd, "existing.txt"), "before\n");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "changes-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("changes-agent"), cwd, (event) => events.push(event));

    try {
      const runId = await service.send("update both files", cwd);
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });
      const changes = service.listChanges(runId);
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ relativePath: "created.txt", kind: "created", status: "pending", revertible: true, patch: expect.stringContaining("created by agent") }),
        expect.objectContaining({ relativePath: "existing.txt", kind: "modified", status: "pending", revertible: true, patch: expect.stringContaining("after") }),
      ]));
      expect(eventsOfType(events, "changes.updated").at(-1)?.changes).toHaveLength(2);

      const created = changes.find((change) => change.kind === "created")!;
      expect(service.revertChanges([created.id]).find((change) => change.id === created.id)?.status).toBe("reverted");
      expect(fs.existsSync(path.join(cwd, "created.txt"))).toBe(false);

      const modified = changes.find((change) => change.kind === "modified")!;
      fs.writeFileSync(path.join(cwd, "existing.txt"), "third-party change\n");
      const conflicted = service.revertChanges([modified.id]).find((change) => change.id === modified.id)!;
      expect(conflicted).toMatchObject({ status: "conflict", error: expect.stringContaining("避免覆盖") });
      expect(fs.readFileSync(path.join(cwd, "existing.txt"), "utf8")).toBe("third-party change\n");
      expect(service.acceptChanges([modified.id]).find((change) => change.id === modified.id)?.status).toBe("accepted");

      const conversation = (await service.listConversations()).find((entry) => entry.cwd === cwd)!;
      const restored = await service.loadConversation(conversation.id);
      expect(restored.turns[0]?.fileChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: created.id, status: "reverted" }),
        expect.objectContaining({ id: modified.id, status: "accepted" }),
      ]));
      expect(service.changePath(modified.id)).toBe(path.join(cwd, "existing.txt"));
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("persists a stopped subagent record when the parent run is aborted", async () => {
    let requestCount = 0;
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => { childStarted = resolve; });
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requestCount += 1;
        if (requestCount === 1) {
          writeSse(res, [
            chunk({ role: "assistant" }),
            chunk({ tool_calls: [{ index: 0, id: "call-stopped-child", type: "function", function: { name: "pi_desktop_subagent", arguments: JSON.stringify({ role: "researcher", task: "Wait for evidence" }) } }] }),
            chunk({}, "tool_calls"),
          ]);
        } else {
          res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
          childStarted();
        }
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("subagent-abort-workspace");
    const agentDir = createDirectory("subagent-abort-agent");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "subagent-abort-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, agentDir, cwd, (event) => events.push(event));

    try {
      const runId = await service.send("delegate and wait", cwd);
      await started;
      await service.abort();
      await vi.waitFor(() => {
        const index = JSON.parse(fs.readFileSync(path.join(agentDir, "sessions", "subagents", "index.json"), "utf8")) as { runs: Array<{ status: string }> };
        expect(index.runs[0]?.status).toBe("stopped");
      });
      expect(events.some((event) => event.type === "run.stopped" && event.runId === runId)).toBe(true);
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("queues steering and follow-up messages during a run and clears them explicitly", async () => {
    let requestStarted!: () => void;
    let finishRequest!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requestStarted();
        finishRequest = () => writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "finished" }), chunk({}, "stop")]);
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("queue-workspace");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "queue-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("queue-agent"), cwd, (event) => events.push(event));

    try {
      const runId = await service.send("start a long task", cwd);
      await started;
      expect(events).toContainEqual(expect.objectContaining({ type: "user.message.started", runId, message: "start a long task" }));
      await expect(service.queueMessage("change direction", "steer")).resolves.toEqual({ steering: ["change direction"], followUp: [] });
      await expect(service.queueMessage("summarize afterward", "followUp")).resolves.toEqual({ steering: ["change direction"], followUp: ["summarize afterward"] });
      expect(eventsOfType(events, "queue.updated")).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId, queue: { steering: ["change direction"], followUp: [] } }),
        expect.objectContaining({ runId, queue: { steering: ["change direction"], followUp: ["summarize afterward"] } }),
      ]));
      expect(service.clearQueue()).toEqual({ steering: [], followUp: [] });
      expect(eventsOfType(events, "queue.updated").at(-1)).toMatchObject({ runId, queue: { steering: [], followUp: [] } });
      finishRequest();
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("emits a user-message lifecycle event when a queued follow-up starts executing", async () => {
    let requestStarted!: () => void;
    let finishFirstRequest!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        if (requests.length === 1) {
          requestStarted();
          finishFirstRequest = () => writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "first answer" }), chunk({}, "stop")]);
        } else {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "follow-up answer" }), chunk({}, "stop")]);
        }
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("queue-lifecycle-workspace");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "queue-lifecycle-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("queue-lifecycle-agent"), cwd, (event) => events.push(event));

    try {
      const runId = await service.send("start a long task", cwd);
      await started;
      await service.queueMessage("summarize afterward", "followUp");
      finishFirstRequest();

      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });

      expect(eventsOfType(events, "user.message.started").map((event) => event.message)).toEqual([
        "start a long task",
        "summarize afterward",
      ]);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages)).toContain("summarize afterward");
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

  it("sends image and text attachments to the model and rebuilds them in history", async () => {
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "seen" }), chunk({}, "stop")]);
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("attachments-workspace");
    const agentDir = createDirectory("attachments-agent");
    const events: AgentEvent[] = [];
    const service = new AgentService({
      resolve: () => ({
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: "mock-model",
        thinkingLevel: "off" as const,
        apiKey: "attachments-key",
      }),
    }, agentDir, cwd, (event) => events.push(event));

    try {
      const largeContent = `large-secret-${"x".repeat(64 * 1024)}`;
      const runId = await service.send("describe this", cwd, "attachments-conversation", {
        images: [{ name: "shot.png", mimeType: "image/png", data: "QUJD" }],
        attachments: [
          { name: "notes.txt", content: "some notes" },
          { name: "large.log", mimeType: "text/plain", content: largeContent },
        ],
      });
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });

      const payload = JSON.stringify(requests[0]?.messages);
      expect(payload).toContain("QUJD");
      expect(payload).toMatch(/<file attachment-id=\\"[0-9a-f-]{36}\\"/);
      expect(payload).toContain('name=\\"notes.txt\\" mime-type=\\"text/plain\\" size=\\"10\\" access=\\"inline\\"');
      expect(payload).toContain("some notes");
      expect(payload).toMatch(/<attachment attachment-id=\\"[0-9a-f-]{36}\\"/);
      expect(payload).toContain('name=\\"large.log\\" mime-type=\\"text/plain\\" size=\\"65549\\" access=\\"read_attachment\\"');
      expect(payload).not.toContain("large-secret-");

      const detail = await service.loadConversation("attachments-conversation");
      expect(detail.turns[0]).toMatchObject({
        question: "describe this",
        attachments: [
          { kind: "image", name: "图片 1", dataUrl: "data:image/png;base64,QUJD" },
          expect.objectContaining({ kind: "file", name: "notes.txt", mimeType: "text/plain", size: 10, access: "inline" }),
          expect.objectContaining({ kind: "file", name: "large.log", mimeType: "text/plain", size: 65_549, access: "tool" }),
        ],
      });
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("rejects images when the catalog marks the model text-only and preserves the flag on disk", async () => {
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        requests.push(JSON.parse(body) as ChatRequest);
        writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "done" }), chunk({}, "stop")]);
      });
    });
    const port = await listen(server);
    const agentDir = createDirectory("text-only-agent");
    fs.writeFileSync(path.join(agentDir, "discovered-models.json"), JSON.stringify({
      version: 2,
      providers: {
        "openai-compatible": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          updatedAt: new Date().toISOString(),
          models: [{ id: "text-only-model", name: "Text Only", reasoning: true, contextWindow: 128_000, supportsImages: false }],
        },
      },
    }));
    const cwd = createDirectory("text-only-workspace");
    const events: AgentEvent[] = [];
    const service = new AgentService({
      resolve: () => ({
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: "text-only-model",
        thinkingLevel: "off" as const,
        apiKey: "text-only-key",
      }),
    }, agentDir, cwd, (event) => events.push(event));

    try {
      const catalog = await service.getModelCatalog(false);
      expect(catalog.find((provider) => provider.id === "openai-compatible")?.models[0]?.supportsImages).toBe(false);
      await expect(service.send("look at this", cwd, undefined, {
        images: [{ name: "a.png", mimeType: "image/png", data: "QUJD" }],
      })).rejects.toThrow("当前模型不支持图片输入");
      // 纯文本附件不受图片能力限制，仍会正常发送并按大小选择附件策略。
      const runId = await service.send("summarize", cwd, undefined, {
        attachments: [{ name: "a.txt", content: "text" }],
      });
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });
      expect(JSON.stringify(requests[0]?.messages)).toContain('name=\\"a.txt\\"');
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("lets the model read a referenced attachment by capability ID without exposing filesystem paths", async () => {
    const requests: ChatRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (part) => { body += part; });
      req.on("end", () => {
        const request = JSON.parse(body) as ChatRequest;
        requests.push(request);
        if (requests.length === 1) {
          const match = JSON.stringify(request.messages).match(/attachment-id=\\?"([0-9a-f-]{36})\\?"/);
          const attachmentId = match?.[1];
          if (!attachmentId) throw new Error("Expected an attachment capability ID in the first request");
          writeSse(res, [
            chunk({ role: "assistant" }),
            chunk({ tool_calls: [{
              index: 0,
              id: "call-read-attachment",
              type: "function",
              function: { name: "read_attachment", arguments: JSON.stringify({ attachmentId, offset: 0, limit: 64 }) },
            }] }),
            chunk({}, "tool_calls"),
          ]);
        } else {
          writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "read it" }), chunk({}, "stop")]);
        }
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("read-attachment-workspace");
    const events: AgentEvent[] = [];
    const service = new AgentService({
      resolve: () => ({
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        modelId: "mock-model",
        thinkingLevel: "off" as const,
        apiKey: "read-attachment-key",
      }),
    }, createDirectory("read-attachment-agent"), cwd, (event) => events.push(event));

    try {
      const runId = await service.send("inspect the attachment", cwd, undefined, {
        attachments: [{ name: "large.txt", content: `tool-secret-start-${"x".repeat(64 * 1024)}` }],
      });
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });
      expect(requests[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "read_attachment" }) })]));
      expect(JSON.stringify(requests[0].messages)).not.toContain("tool-secret-start");
      expect(JSON.stringify(requests[1].messages)).toContain("tool-secret-start");
      const tool = events.find((event) => event.type === "tool.completed" && event.name === "read_attachment");
      expect(tool).toMatchObject({ isError: false });
      expect(JSON.stringify((tool as Extract<AgentEvent, { type: "tool.completed" }>).details)).not.toContain(cwd);
    } finally {
      service.dispose();
      await close(server);
    }
  });

  it("marks discovered models text-only when the endpoint declares modalities without image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: "text-model", architecture: { input_modalities: ["text"] } },
      { id: "vision-model", architecture: { input_modalities: ["text", "image"] } },
      { id: "modalities-model", modalities: { input: ["text"] } },
      { id: "plain-model" },
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new AgentService(
      { resolve: () => ({ provider: "openai-compatible", baseUrl: "https://models.example/v1", modelId: "plain-model", thinkingLevel: "off" }) },
      createDirectory("modalities-agent"),
      createDirectory("modalities-workspace"),
      () => {},
    );

    try {
      const models = await service.discoverModels({
        provider: "openai-compatible",
        baseUrl: "https://models.example/v1",
        modelId: "plain-model",
        thinkingLevel: "off",
      });
      const byId = new Map(models.map((model) => [model.id, model.supportsImages]));
      expect(byId.get("text-model")).toBe(false);
      expect(byId.get("modalities-model")).toBe(false);
      expect(byId.get("vision-model")).toBeUndefined();
      expect(byId.get("plain-model")).toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  it("composes queued steering messages with file attachment blocks", async () => {
    let requestStarted!: () => void;
    let finishRequest!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requestStarted();
        finishRequest = () => writeSse(res, [chunk({ role: "assistant" }), chunk({ content: "finished" }), chunk({}, "stop")]);
      });
    });
    const port = await listen(server);
    const cwd = createDirectory("queue-attachments-workspace");
    const configuration: SaveModelSettings = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelId: "mock-model",
      thinkingLevel: "off",
      apiKey: "queue-attachments-key",
    };
    const events: AgentEvent[] = [];
    const service = new AgentService({ resolve: () => ({ ...configuration }) }, createDirectory("queue-attachments-agent"), cwd, (event) => events.push(event));

    try {
      const runId = await service.send("start a long task", cwd);
      await started;
      const queue = await service.queueMessage("adjust plan", "steer", {
        attachments: [{ name: "spec.md", content: "# spec" }],
      });
      expect(queue.followUp).toEqual([]);
      expect(queue.steering).toHaveLength(1);
      expect(queue.steering[0]).toMatch(/^adjust plan\n\n<file attachment-id="[0-9a-f-]{36}" name="spec.md" mime-type="text\/plain" size="6" access="inline">\n# spec\n<\/file>$/);
      expect(service.clearQueue()).toEqual({ steering: [], followUp: [] });
      finishRequest();
      await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed" && event.runId === runId)).toBe(true), { timeout: 8_000 });
    } finally {
      service.dispose();
      await close(server);
    }
  });
});
