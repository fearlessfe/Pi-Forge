import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpStore, type McpStorageEncryption } from "./mcp-store.js";

const cleanup: string[] = [];
const encryption: McpStorageEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value.split("").reverse().join("")),
  decryptString: (value) => value.toString().split("").reverse().join(""),
};

function directory(label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `pi-mcp-${label}-`));
  cleanup.push(target);
  return target;
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("McpStore", () => {
  it("persists user and project configurations while keeping secrets encrypted and separate", () => {
    const userData = directory("user");
    const project = directory("project");
    const store = new McpStore(userData, encryption);

    const user = store.save({
      id: "remote-search",
      name: "Remote search",
      scope: "user",
      enabled: true,
      timeoutMs: 15_000,
      transport: { type: "streamable-http", url: "https://example.com/mcp", headers: { "X-Client": "Pi" } },
      secretHeaders: { Authorization: "Bearer very-secret-token" },
    });
    const local = store.save({
      id: "project-files",
      name: "Project files",
      scope: "project",
      projectPath: project,
      enabled: false,
      timeoutMs: 60_000,
      transport: { type: "stdio", command: "node", args: ["server.mjs"], cwd: ".", environment: { MODE: "read-only" } },
      secretEnvironment: { API_KEY: "project-secret" },
    });

    expect(store.list(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: user.key, scope: "user", hasCredentials: true }),
      expect.objectContaining({ key: local.key, scope: "project", projectPath: fs.realpathSync(project), hasCredentials: true }),
    ]));
    expect(fs.readFileSync(path.join(userData, "mcp-servers.json"), "utf8")).not.toContain("very-secret-token");
    expect(fs.readFileSync(path.join(project, ".pi", "mcp.json"), "utf8")).not.toContain("project-secret");
    expect(fs.readFileSync(path.join(userData, "mcp-credentials.enc.json"), "utf8")).not.toContain("very-secret-token");
    expect(new McpStore(userData, encryption).resolved(user).secrets.headers.Authorization).toBe("Bearer very-secret-token");
  });

  it("validates transport boundaries and can clear credentials", () => {
    const userData = directory("user");
    const project = directory("project");
    const store = new McpStore(userData, encryption);
    expect(() => store.save({
      id: "unsafe",
      name: "Unsafe",
      scope: "project",
      projectPath: project,
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "stdio", command: "node", args: [], cwd: "../outside", environment: {} },
    })).toThrow("项目内的相对路径");
    expect(() => store.save({
      id: "bad-url",
      name: "Bad URL",
      scope: "user",
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "streamable-http", url: "https://token@example.com/mcp", headers: {} },
    })).toThrow("不能内嵌凭据");

    const saved = store.save({
      id: "clearable",
      name: "Clearable",
      scope: "user",
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
      secretEnvironment: { TOKEN: "secret" },
    });
    expect(saved.hasCredentials).toBe(true);
    const cleared = store.save({
      previousKey: saved.key,
      id: saved.id,
      name: saved.name,
      scope: saved.scope,
      enabled: saved.enabled,
      timeoutMs: saved.timeoutMs,
      transport: saved.transport,
      clearCredentials: true,
    });
    expect(cleared.hasCredentials).toBe(false);
  });

  it("rejects malformed identities, timeouts, environments, headers, and transports", () => {
    const store = new McpStore(directory("validation"), encryption);
    const base = {
      id: "valid-id",
      name: "Valid",
      scope: "user" as const,
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "stdio" as const, command: "node", args: [], environment: {} },
    };

    expect(() => store.save({ ...base, id: " invalid id " })).toThrow("ID 只能包含");
    expect(() => store.save({ ...base, name: " " })).toThrow("名称不能为空");
    expect(() => store.save({ ...base, scope: "invalid" as "user" })).toThrow("作用域无效");
    expect(() => store.save({ ...base, scope: "project", projectPath: "relative" })).toThrow("有效的项目路径");
    expect(() => store.save({ ...base, enabled: "yes" as unknown as boolean })).toThrow("启用状态无效");
    expect(() => store.save({ ...base, timeoutMs: 999 })).toThrow("介于 1 秒");
    expect(() => store.save({ ...base, transport: { type: "stdio", command: "bad\ncommand", args: [], environment: {} } })).toThrow("stdio 命令无效");
    expect(() => store.save({ ...base, transport: { type: "stdio", command: "node", args: ["bad\0arg"], environment: {} } })).toThrow("stdio 参数无效");
    expect(() => store.save({ ...base, transport: { type: "stdio", command: "node", args: [], environment: { "BAD-KEY": "x" } } })).toThrow("环境变量字段无效");
    expect(() => store.save({ ...base, transport: { type: "streamable-http", url: "file:///tmp/server", headers: {} } })).toThrow("必须使用 http/https");
    expect(() => store.save({ ...base, transport: { type: "streamable-http", url: "not a url", headers: {} } })).toThrow("URL 无效");
    expect(() => store.save({ ...base, transport: { type: "streamable-http", url: "https://example.com", headers: { "bad header": "x" } } })).toThrow("请求头字段无效");
    expect(() => store.save({ ...base, transport: { type: "unknown" } as never })).toThrow("传输类型无效");
    expect(() => store.save(null as never)).toThrow("配置格式无效");
  });

  it("renames and removes servers without orphaning encrypted credentials", () => {
    const userData = directory("rename");
    const store = new McpStore(userData, encryption);
    const original = store.save({
      id: "old-id",
      name: "Original",
      scope: "user",
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
      secretEnvironment: { TOKEN: "rename-secret" },
    });
    const renamed = store.save({
      previousKey: original.key,
      id: "new-id",
      name: "Renamed",
      scope: "user",
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
    });

    expect(store.list()).toEqual([expect.objectContaining({ id: "new-id", hasCredentials: true })]);
    expect(store.resolved(renamed).secrets.environment).toEqual({ TOKEN: "rename-secret" });
    store.remove(renamed.key);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(path.join(userData, "mcp-credentials.enc.json"))).toBe(false);
    expect(() => store.remove("user:missing")).toThrow("找不到该 MCP Server");
  });

  it("recovers valid records from partially corrupted configuration files", () => {
    const userData = directory("corruption");
    fs.writeFileSync(path.join(userData, "mcp-servers.json"), JSON.stringify({
      version: 1,
      servers: [
        { id: "valid", name: "Valid", enabled: true, timeoutMs: 5_000, transport: { type: "stdio", command: "node", args: [], environment: {} } },
        { id: "bad id", name: "Bad", enabled: true, timeoutMs: 5_000, transport: { type: "stdio", command: "node", args: [], environment: {} } },
      ],
    }));
    const store = new McpStore(userData, encryption);
    expect(store.list()).toEqual([expect.objectContaining({ id: "valid" })]);

    fs.writeFileSync(path.join(userData, "mcp-servers.json"), "not-json");
    expect(store.list()).toEqual([]);
    fs.writeFileSync(path.join(userData, "mcp-servers.json"), JSON.stringify({ version: 2, servers: [] }));
    expect(store.list()).toEqual([]);
  });

  it("refuses to persist secrets when operating-system encryption is unavailable", () => {
    const userData = directory("unencrypted");
    const unavailable: McpStorageEncryption = {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString("utf8"),
    };
    const store = new McpStore(userData, unavailable);
    expect(() => store.save({
      id: "secret",
      name: "Secret",
      scope: "user",
      enabled: true,
      timeoutMs: 5_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
      secretEnvironment: { TOKEN: "secret" },
    })).toThrow("安全存储当前不可用");
  });
});
