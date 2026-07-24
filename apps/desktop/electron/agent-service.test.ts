import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      modelId: "mock-model",
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
                  name: "spawn_subagent",
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
      expect(events.some((event) => event.type === "tool.started" && event.name === "spawn_subagent")).toBe(true);
      expect(events.some((event) => event.type === "tool.updated" && event.name === "spawn_subagent" && event.output.includes("child-report"))).toBe(true);
      expect(events.some((event) => event.type === "tool.completed" && event.name === "spawn_subagent" && event.output.includes("child-report"))).toBe(true);
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
