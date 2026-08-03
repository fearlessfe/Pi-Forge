import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpService, type McpClientFactory, type McpClientLike } from "./mcp-service.js";
import { McpStore, type McpStorageEncryption } from "./mcp-store.js";

const cleanup: string[] = [];
const encryption: McpStorageEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

function directory(label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `pi-mcp-service-${label}-`));
  cleanup.push(target);
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("McpService", () => {
  it("inventories configured MCP servers without connecting them", async () => {
    const store = new McpStore(directory("context-inventory"), encryption);
    store.save({
      id: "offline",
      name: "Offline MCP",
      scope: "user",
      enabled: true,
      timeoutMs: 2_000,
      transport: { type: "streamable-http", url: "https://example.com/mcp", headers: {} },
    });
    const factory = vi.fn();
    const service = new McpService(store, { isProjectTrusted: () => false }, factory);

    await expect(service.contextInventory()).resolves.toEqual([
      expect.objectContaining({ name: "Offline MCP", enabled: true, schemaAvailable: false, tools: [] }),
    ]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("connects, namespaces tools, forwards calls and exposes lifecycle status", async () => {
    const userData = directory("user");
    const store = new McpStore(userData, encryption);
    store.save({
      id: "search-api",
      name: "Search API",
      scope: "user",
      enabled: true,
      timeoutMs: 12_000,
      transport: { type: "streamable-http", url: "https://example.com/mcp", headers: {} },
      secretHeaders: { Authorization: "secret" },
    });
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "found it" }], structuredContent: { count: 1 } }));
    const close = vi.fn(async () => undefined);
    const client: McpClientLike = {
      connect: vi.fn(async () => undefined),
      close,
      listTools: vi.fn(async () => ({ tools: [{ name: "web-search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] })),
      callTool,
      getServerVersion: () => ({ name: "test-server", version: "1.2.3" }),
    };
    const factory: McpClientFactory = (server) => {
      expect(server.secrets.headers.Authorization).toBe("secret");
      return { client, transport: {} };
    };
    const service = new McpService(store, { isProjectTrusted: () => false }, factory);

    const tools = await service.tools();
    expect(tools).toEqual([expect.objectContaining({ name: "mcp__search_api__web_search", remoteName: "web-search" })]);
    await expect(service.contextInventory()).resolves.toEqual([
      expect.objectContaining({ name: "Search API", enabled: true, tools }),
    ]);
    await expect(service.callTool(tools[0], { query: "Pi" })).resolves.toMatchObject({ text: expect.stringContaining("found it") });
    expect(callTool).toHaveBeenCalledWith({ name: "web-search", arguments: { query: "Pi" } }, undefined, expect.objectContaining({ timeout: 12_000 }));
    expect(service.overview().runtimes[0]).toMatchObject({ state: "connected", serverName: "test-server", serverVersion: "1.2.3" });
    await service.disconnect(store.list()[0].key);
    expect(close).toHaveBeenCalledOnce();
    expect(service.overview().runtimes[0].state).toBe("disconnected");
  });

  it("blocks project servers until the project is trusted and isolates connection failures", async () => {
    const userData = directory("user");
    const project = directory("project");
    const store = new McpStore(userData, encryption);
    const projectServer = store.save({
      id: "project-tools",
      name: "Project tools",
      scope: "project",
      projectPath: project,
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "stdio", command: "node", args: ["server.js"], environment: {} },
    });
    const failingClient: McpClientLike = {
      connect: vi.fn(async () => { throw new Error("credential leaked-value rejected"); }),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [] })),
      callTool: vi.fn(async () => ({ content: [] })),
      getServerVersion: () => undefined,
    };
    const service = new McpService(store, { isProjectTrusted: () => false }, () => ({ client: failingClient }));

    expect(service.overview(project).servers).toHaveLength(0);
    await expect(service.connect(projectServer.key, project)).rejects.toThrow("尚未受信任");

    const trusted = new McpService(store, { isProjectTrusted: (cwd) => fs.realpathSync(cwd) === fs.realpathSync(project) }, () => ({ client: failingClient }));
    await expect(trusted.tools(project)).resolves.toEqual([]);
    expect(trusted.overview(project).runtimes[0]).toMatchObject({ state: "error", error: expect.stringContaining("credential") });
  });

  it("normalizes heterogeneous MCP results into a safe transcript", async () => {
    const store = new McpStore(directory("results"), encryption);
    const saved = store.save({
      id: "content-api",
      name: "Content API",
      scope: "user",
      enabled: true,
      timeoutMs: 4_000,
      transport: { type: "streamable-http", url: "https://example.com/mcp", headers: {} },
    });
    const structured = { records: 2 };
    const client: McpClientLike = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [
        { name: "Fetch / Content", description: "   ", inputSchema: undefined },
        { name: "typed", inputSchema: { properties: { id: { type: "string" } } } },
        { name: "   " },
        { name: 42 as unknown as string },
      ] })),
      callTool: vi.fn(async () => ({
        content: [
          { type: "text", text: "plain text" },
          { type: "resource_link", name: "Guide", uri: "file:///guide.md" },
          { type: "resource_link", uri: "https://example.com/resource" },
          { type: "resource", resource: { uri: "file:///notes", text: "resource text" } },
          { type: "resource", resource: { uri: "file:///binary" } },
          { type: "image", mimeType: "image/png" },
          { type: "audio", mimeType: "audio/wav" },
          { type: "custom", value: 3 },
          null,
        ],
        structuredContent: structured,
      })),
      getServerVersion: () => undefined,
    };
    const service = new McpService(store, { isProjectTrusted: () => false }, () => ({ client }));

    const tools = await service.tools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: "mcp__content_api__fetch_content",
        description: "Call Fetch / Content on MCP server Content API.",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      }),
      expect.objectContaining({
        name: "mcp__content_api__typed",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      }),
    ]);
    const result = await service.callTool(tools[0], {});
    expect(result.text).toContain("plain text");
    expect(result.text).toContain("Resource: Guide (file:///guide.md)");
    expect(result.text).toContain("Resource: https://example.com/resource (https://example.com/resource)");
    expect(result.text).toContain("resource text");
    expect(result.text).toContain("Resource: file:///binary");
    expect(result.text).toContain("[Image: image/png");
    expect(result.text).toContain("[Audio: audio/wav");
    expect(result.text).toContain('"value": 3');
    expect(result.text).toContain('"records": 2');
    expect(result.details).toEqual({ serverKey: saved.key, remoteName: "Fetch / Content", structuredContent: structured });
  });

  it("surfaces remote tool errors, disconnected calls, and non-text completion", async () => {
    const store = new McpStore(directory("errors"), encryption);
    store.save({
      id: "errors",
      name: "Errors",
      scope: "user",
      enabled: true,
      timeoutMs: 3_000,
      transport: { type: "streamable-http", url: "https://example.com/mcp", headers: {} },
    });
    const callTool = vi.fn(async (): Promise<{ content: unknown[]; isError?: boolean }> => ({ content: [] }))
      .mockResolvedValueOnce({ content: [], isError: false })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "remote rejected input" }], isError: true })
      .mockRejectedValueOnce("transport stopped");
    const client: McpClientLike = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [{ name: "run" }] })),
      callTool,
      getServerVersion: () => ({ name: "errors", version: "1" }),
    };
    const service = new McpService(store, { isProjectTrusted: () => false }, () => ({ client }));

    const descriptor = (await service.tools())[0];
    await expect(service.callTool(descriptor, {})).resolves.toMatchObject({ text: "MCP tool completed without text output." });
    await expect(service.callTool(descriptor, {})).rejects.toThrow("remote rejected input");
    await expect(service.callTool(descriptor, {})).rejects.toBe("transport stopped");
    expect(service.overview().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "error", message: expect.stringContaining("remote rejected input") }),
      expect.objectContaining({ level: "error", message: expect.stringContaining("transport stopped") }),
    ]));

    const disconnected = new McpService(store, { isProjectTrusted: () => false }, () => ({ client }));
    await expect(disconnected.callTool(descriptor, {})).rejects.toThrow("当前未连接");
  });

  it("handles save, reconnect, removal, close failures, and disabled servers", async () => {
    const store = new McpStore(directory("lifecycle"), encryption);
    const clients: McpClientLike[] = [];
    const factory: McpClientFactory = () => {
      const client: McpClientLike = {
        connect: vi.fn(async () => undefined),
        close: vi.fn(async () => { throw new Error("close failed"); }),
        listTools: vi.fn(async () => ({ tools: [{ name: "status" }] })),
        callTool: vi.fn(async () => ({ content: [] })),
        getServerVersion: () => undefined,
      };
      clients.push(client);
      return { client };
    };
    const service = new McpService(store, { isProjectTrusted: () => false }, factory);
    const overview = service.save({
      id: "lifecycle",
      name: "Lifecycle",
      scope: "user",
      enabled: true,
      timeoutMs: 2_000,
      transport: { type: "streamable-http", url: "https://example.com/mcp", headers: {} },
    });
    const key = overview.servers[0].key;

    await service.connect(key);
    await service.reconnect(key);
    expect(clients).toHaveLength(2);
    expect(service.overview().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "error", message: expect.stringContaining("Disconnect failed: close failed") }),
    ]));
    await service.remove(key);
    expect(service.overview().servers).toEqual([]);

    const disabled = service.save({
      id: "disabled",
      name: "Disabled",
      scope: "user",
      enabled: false,
      timeoutMs: 2_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
    });
    await service.connect(disabled.servers[0].key);
    expect(service.overview().runtimes[0].state).toBe("disabled");
    await expect(service.contextInventory()).resolves.toEqual([
      expect.objectContaining({ name: "Disabled", enabled: false, tools: [] }),
    ]);
    expect(clients).toHaveLength(2);
    await service.disconnect("missing-key");
  });

  it("disambiguates project and user servers and redacts secrets from stderr and failures", async () => {
    const userData = directory("namespaces-user");
    const project = directory("namespaces-project");
    const store = new McpStore(userData, encryption);
    store.save({
      id: "shared",
      name: "User shared",
      scope: "user",
      enabled: true,
      timeoutMs: 2_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
      secretEnvironment: { TOKEN: "top-secret" },
    });
    store.save({
      id: "shared",
      name: "Project shared",
      scope: "project",
      projectPath: project,
      enabled: true,
      timeoutMs: 2_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
    });
    const stderrListeners: Array<(chunk: Buffer | string) => void> = [];
    let created = 0;
    const service = new McpService(store, { isProjectTrusted: (cwd) => fs.realpathSync(cwd) === fs.realpathSync(project) }, (server) => {
      created += 1;
      const fail = Boolean(server.secrets.environment.TOKEN);
      return {
        client: {
          connect: vi.fn(async () => { if (fail) throw new Error("top-secret rejected"); }),
          close: vi.fn(async () => undefined),
          listTools: vi.fn(async () => ({ tools: [{ name: "inspect" }] })),
          callTool: vi.fn(async () => ({ content: [] })),
          getServerVersion: () => undefined,
        },
        stderr: { on: (_event, listener) => { stderrListeners.push(listener); } },
      };
    });

    const tools = await service.tools(project);
    expect(created).toBe(2);
    expect(tools).toEqual([expect.objectContaining({ name: "mcp__project_shared__inspect" })]);
    stderrListeners[0]("diagnostic includes top-secret\n");
    const overview = service.overview(project);
    expect(overview.runtimes).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "error", error: "[REDACTED] rejected" }),
      expect.objectContaining({ state: "connected" }),
    ]));
    expect(JSON.stringify(overview.logs)).not.toContain("top-secret");
    expect(JSON.stringify(overview.logs)).toContain("[REDACTED]");
    await service.dispose();
  });
});
