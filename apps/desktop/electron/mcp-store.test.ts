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
});
