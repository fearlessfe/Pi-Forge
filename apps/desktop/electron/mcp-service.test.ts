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
});
