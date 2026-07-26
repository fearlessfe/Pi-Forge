import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpLogEntry,
  McpOverview,
  McpServerConfig,
  McpServerRuntime,
  McpToolInfo,
  SaveMcpServerInput,
} from "../src/contracts.js";
import { McpStore } from "./mcp-store.js";

type McpRemoteTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpCallResult = {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
};

export type McpClientLike = {
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
  listTools(params?: unknown, options?: { timeout?: number }): Promise<{ tools: McpRemoteTool[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, schema?: unknown, options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number }): Promise<McpCallResult>;
  getServerVersion(): { name: string; version: string } | undefined;
};

type CreatedClient = {
  client: McpClientLike;
  transport?: unknown;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
};

export type McpClientFactory = (
  server: ReturnType<McpStore["resolved"]>,
  runtimeCwd?: string,
) => CreatedClient;

type Connection = {
  client: McpClientLike;
  server: McpServerConfig;
  tools: McpRemoteTool[];
};

export type McpToolDescriptor = McpToolInfo & {
  serverKey: string;
  inputSchema: Record<string, unknown>;
};

type TrustReader = { isProjectTrusted(cwd: string): boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedToolPart(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

function resultText(result: McpCallResult): string {
  const lines = result.content.flatMap((item): string[] => {
    if (!item || typeof item !== "object") return [String(item ?? "")];
    const content = item as Record<string, unknown>;
    if (content.type === "text" && typeof content.text === "string") return [content.text];
    if (content.type === "resource_link" && typeof content.uri === "string") return [`Resource: ${content.name ?? content.uri} (${content.uri})`];
    if (content.type === "resource" && content.resource && typeof content.resource === "object") {
      const resource = content.resource as Record<string, unknown>;
      if (typeof resource.text === "string") return [resource.text];
      return [`Resource: ${String(resource.uri ?? "unknown")}`];
    }
    if (content.type === "image") return [`[Image: ${String(content.mimeType ?? "unknown")}, base64 payload omitted from transcript]`];
    if (content.type === "audio") return [`[Audio: ${String(content.mimeType ?? "unknown")}, base64 payload omitted from transcript]`];
    try {
      return [JSON.stringify(content, null, 2)];
    } catch {
      return [String(content)];
    }
  }).filter(Boolean);
  if (result.structuredContent !== undefined) {
    try {
      lines.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
    } catch {
      lines.push("Structured content was not serializable.");
    }
  }
  return lines.join("\n") || "MCP tool completed without text output.";
}

function defaultFactory(server: ReturnType<McpStore["resolved"]>, runtimeCwd?: string): CreatedClient {
  const client = new Client({ name: "pi-desktop", version: "0.1.0" }) as McpClientLike;
  if (server.transport.type === "stdio") {
    const workingDirectory = server.transport.cwd
      ? path.resolve(server.scope === "project" ? server.projectPath as string : runtimeCwd ?? process.cwd(), server.transport.cwd)
      : server.scope === "project"
        ? server.projectPath
        : runtimeCwd;
    const transport = new StdioClientTransport({
      command: server.transport.command,
      args: server.transport.args,
      cwd: workingDirectory,
      env: {
        ...getDefaultEnvironment(),
        ...server.transport.environment,
        ...server.secrets.environment,
      },
      stderr: "pipe",
    });
    return { client, transport, stderr: transport.stderr };
  }
  const transport = new StreamableHTTPClientTransport(new URL(server.transport.url), {
    requestInit: {
      headers: { ...server.transport.headers, ...server.secrets.headers },
    },
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 5_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 2,
    },
  });
  return { client, transport };
}

export class McpService {
  private readonly connections = new Map<string, Connection>();
  private readonly runtimes = new Map<string, McpServerRuntime>();
  private readonly logs: McpLogEntry[] = [];

  constructor(
    private readonly store: McpStore,
    private readonly trust: TrustReader,
    private readonly factory: McpClientFactory = defaultFactory,
  ) {}

  overview(cwd?: string): McpOverview {
    const servers = this.servers(cwd);
    return {
      servers,
      runtimes: servers.map((server) => this.runtime(server)),
      logs: this.logs.filter((entry) => servers.some((server) => server.key === entry.serverKey)).map((entry) => ({ ...entry })),
    };
  }

  save(input: SaveMcpServerInput): McpOverview {
    if (input.scope === "project") this.requireTrustedProject(input.projectPath);
    const previousKey = input.previousKey;
    if (previousKey) void this.disconnect(previousKey).catch(() => undefined);
    const saved = this.store.save(input);
    this.setRuntime(saved, saved.enabled ? "disconnected" : "disabled");
    this.log(saved.key, "info", `Saved ${saved.transport.type} server configuration.`);
    return this.overview(saved.projectPath);
  }

  async remove(key: string, cwd?: string): Promise<McpOverview> {
    const server = this.findServer(key, cwd);
    if (server.scope === "project") this.requireTrustedProject(server.projectPath);
    await this.disconnect(key, cwd);
    this.store.remove(key, server.projectPath);
    this.runtimes.delete(key);
    this.log(key, "info", "Removed server configuration.");
    return this.overview(cwd);
  }

  async connect(key: string, cwd?: string): Promise<McpOverview> {
    const server = this.findServer(key, cwd);
    await this.connectServer(server, cwd);
    return this.overview(cwd);
  }

  async disconnect(key: string, cwd?: string): Promise<McpOverview> {
    const connection = this.connections.get(key);
    if (connection) {
      this.connections.delete(key);
      try {
        await connection.client.close();
      } catch (error) {
        this.log(key, "error", `Disconnect failed: ${errorMessage(error)}`);
      }
    }
    const server = this.servers(cwd).find((entry) => entry.key === key);
    if (server) this.setRuntime(server, server.enabled ? "disconnected" : "disabled");
    return this.overview(cwd);
  }

  async reconnect(key: string, cwd?: string): Promise<McpOverview> {
    await this.disconnect(key, cwd);
    return this.connect(key, cwd);
  }

  async tools(cwd?: string): Promise<McpToolDescriptor[]> {
    const servers = this.servers(cwd).filter((server) => server.enabled);
    await Promise.all(servers.map(async (server) => {
      try {
        await this.connectServer(server, cwd);
      } catch {
        // One unavailable MCP server must not prevent the Agent from starting.
      }
    }));
    const serverIdCounts = new Map<string, number>();
    for (const server of servers) serverIdCounts.set(normalizedToolPart(server.id), (serverIdCounts.get(normalizedToolPart(server.id)) ?? 0) + 1);
    return servers.flatMap((server) => {
      const connection = this.connections.get(server.key);
      if (!connection) return [];
      const serverPart = normalizedToolPart(server.id);
      const prefix = (serverIdCounts.get(serverPart) ?? 0) > 1 ? `${server.scope}_${serverPart}` : serverPart;
      return connection.tools.map((tool): McpToolDescriptor => ({
        name: `mcp__${prefix}__${normalizedToolPart(tool.name)}`,
        remoteName: tool.name,
        description: tool.description?.trim() || `Call ${tool.name} on MCP server ${server.name}.`,
        serverKey: server.key,
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object"
          ? { ...tool.inputSchema, type: tool.inputSchema.type ?? "object" }
          : { type: "object", properties: {}, additionalProperties: true },
      }));
    });
  }

  async callTool(descriptor: McpToolDescriptor, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; details: unknown }> {
    const connection = this.connections.get(descriptor.serverKey);
    if (!connection) throw new Error("MCP Server 当前未连接，请重新加载 MCP 配置。");
    this.log(descriptor.serverKey, "info", `Calling tool ${descriptor.remoteName}.`);
    try {
      const result = await connection.client.callTool(
        { name: descriptor.remoteName, arguments: args },
        undefined,
        { signal, timeout: connection.server.timeoutMs, maxTotalTimeout: connection.server.timeoutMs },
      );
      const text = resultText(result);
      if (result.isError) throw new Error(text);
      this.log(descriptor.serverKey, "info", `Tool ${descriptor.remoteName} completed.`);
      return { text, details: { serverKey: descriptor.serverKey, remoteName: descriptor.remoteName, structuredContent: result.structuredContent } };
    } catch (error) {
      this.log(descriptor.serverKey, "error", `Tool ${descriptor.remoteName} failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map((connection) => connection.client.close()));
  }

  private async connectServer(server: McpServerConfig, cwd?: string): Promise<void> {
    if (!server.enabled) {
      this.setRuntime(server, "disabled");
      return;
    }
    if (this.connections.has(server.key)) return;
    if (server.scope === "project") this.requireTrustedProject(server.projectPath);
    this.setRuntime(server, "connecting");
    this.log(server.key, "info", `Connecting via ${server.transport.type}.`);
    const resolved = this.store.resolved(server);
    const created = this.factory(resolved, cwd);
    if (created.stderr) {
      created.stderr.on("data", (chunk: Buffer | string) => {
        const message = this.redact(String(chunk), resolved).trim();
        if (message) this.log(server.key, "info", `stderr: ${message}`);
      });
    }
    try {
      await created.client.connect(created.transport, { timeout: server.timeoutMs });
      const listed = await created.client.listTools(undefined, { timeout: server.timeoutMs });
      const tools = listed.tools.filter((tool) => typeof tool.name === "string" && tool.name.trim());
      this.connections.set(server.key, { client: created.client, server, tools });
      const version = created.client.getServerVersion();
      this.runtimes.set(server.key, {
        key: server.key,
        state: "connected",
        serverName: version?.name,
        serverVersion: version?.version,
        tools: tools.map((tool) => ({
          name: `mcp__${normalizedToolPart(server.id)}__${normalizedToolPart(tool.name)}`,
          remoteName: tool.name,
          description: tool.description?.trim() || "",
        })),
        updatedAt: new Date().toISOString(),
      });
      this.log(server.key, "info", `Connected; discovered ${tools.length} tool(s).`);
    } catch (error) {
      await created.client.close().catch(() => undefined);
      this.runtimes.set(server.key, {
        key: server.key,
        state: "error",
        error: this.redact(errorMessage(error), resolved),
        tools: [],
        updatedAt: new Date().toISOString(),
      });
      this.log(server.key, "error", `Connection failed: ${this.redact(errorMessage(error), resolved)}`);
      throw error;
    }
  }

  private servers(cwd?: string): McpServerConfig[] {
    return this.store.list(cwd && this.trust.isProjectTrusted(cwd) ? cwd : undefined);
  }

  private findServer(key: string, cwd?: string): McpServerConfig {
    const server = this.servers(cwd).find((entry) => entry.key === key);
    if (!server) throw new Error("找不到该 MCP Server，或项目尚未受信任。");
    return server;
  }

  private requireTrustedProject(projectPath?: string): asserts projectPath is string {
    if (!projectPath || !this.trust.isProjectTrusted(projectPath)) throw new Error("项目级 MCP Server 仅能在受信任项目中配置和运行。");
  }

  private runtime(server: McpServerConfig): McpServerRuntime {
    return this.runtimes.get(server.key) ?? {
      key: server.key,
      state: server.enabled ? "disconnected" : "disabled",
      tools: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private setRuntime(server: McpServerConfig, state: McpServerRuntime["state"]): void {
    this.runtimes.set(server.key, { key: server.key, state, tools: [], updatedAt: new Date().toISOString() });
  }

  private log(serverKey: string, level: McpLogEntry["level"], message: string): void {
    this.logs.push({ id: randomUUID(), serverKey, timestamp: new Date().toISOString(), level, message: message.slice(0, 4_000) });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }

  private redact(message: string, server: ReturnType<McpStore["resolved"]>): string {
    let redacted = message;
    const secrets = [...Object.values(server.secrets.environment), ...Object.values(server.secrets.headers)].filter((value) => value.length >= 3);
    for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
    return redacted;
  }
}
