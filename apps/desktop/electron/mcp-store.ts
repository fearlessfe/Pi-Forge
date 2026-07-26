import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  McpServerConfig,
  McpServerScope,
  SaveMcpServerInput,
} from "../src/contracts.js";

type StoredMcpFile = {
  version: 1;
  servers: StoredMcpServer[];
};

type StoredMcpServer = Omit<McpServerConfig, "key" | "hasCredentials" | "projectPath" | "scope">;

type McpSecrets = {
  environment: Record<string, string>;
  headers: Record<string, string>;
};

type StoredMcpCredentials = {
  version: 1;
  encrypted: string;
};

export type McpStorageEncryption = Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">;

const serverIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;
const environmentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function serverKey(scope: McpServerScope, id: string, projectPath?: string): string {
  return scope === "user" ? `user:${id}` : `project:${canonicalPath(projectPath ?? "")}:${id}`;
}

function emptySecrets(): McpSecrets {
  return { environment: {}, headers: {} };
}

function stringRecord(value: unknown, label: string, keyPattern: RegExp): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keyPattern.test(key) || typeof entry !== "string") throw new Error(`${label}字段无效：${key}`);
    output[key] = entry;
  }
  return output;
}

function atomicWrite(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

export class McpStore {
  private readonly userConfigPath: string;
  private readonly credentialPath: string;
  private readonly secrets = new Map<string, McpSecrets>();

  constructor(
    private readonly userDataPath: string,
    private readonly encryption: McpStorageEncryption = safeStorage,
  ) {
    this.userConfigPath = path.join(userDataPath, "mcp-servers.json");
    this.credentialPath = path.join(userDataPath, "mcp-credentials.enc.json");
    this.loadSecrets();
  }

  list(projectPath?: string): McpServerConfig[] {
    const project = projectPath ? canonicalPath(projectPath) : undefined;
    return [
      ...this.readFile(this.userConfigPath).servers.map((server) => this.publicServer(server, "user")),
      ...(project ? this.readFile(this.projectConfigPath(project)).servers.map((server) => this.publicServer(server, "project", project)) : []),
    ];
  }

  save(input: SaveMcpServerInput): McpServerConfig {
    const validated = this.validateInput(input);
    const project = validated.scope === "project" ? canonicalPath(validated.projectPath as string) : undefined;
    const key = serverKey(validated.scope, validated.id, project);
    const filePath = validated.scope === "user" ? this.userConfigPath : this.projectConfigPath(project as string);
    const current = this.readFile(filePath);
    const previousId = this.idFromKey(input.previousKey, validated.scope, project);
    const duplicate = current.servers.find((server) => server.id === validated.id && server.id !== previousId);
    if (duplicate) throw new Error(`MCP Server ID 已存在：${validated.id}`);

    const stored: StoredMcpServer = {
      id: validated.id,
      name: validated.name,
      enabled: validated.enabled,
      timeoutMs: validated.timeoutMs,
      transport: validated.transport,
    };
    const servers = current.servers.filter((server) => server.id !== previousId && server.id !== validated.id);
    servers.push(stored);
    atomicWrite(filePath, { version: 1, servers } satisfies StoredMcpFile);

    const previousKey = input.previousKey && input.previousKey !== key ? input.previousKey : undefined;
    const previousSecrets = previousKey ? this.secrets.get(previousKey) : this.secrets.get(key);
    if (previousKey) this.secrets.delete(previousKey);
    if (input.clearCredentials) {
      this.secrets.delete(key);
    } else {
      const secretEnvironment = stringRecord(input.secretEnvironment, "MCP 私密环境变量", environmentKeyPattern);
      const secretHeaders = stringRecord(input.secretHeaders, "MCP 私密请求头", headerNamePattern);
      const nextSecrets = {
        environment: Object.keys(secretEnvironment).length ? secretEnvironment : previousSecrets?.environment ?? {},
        headers: Object.keys(secretHeaders).length ? secretHeaders : previousSecrets?.headers ?? {},
      };
      if (Object.keys(nextSecrets.environment).length || Object.keys(nextSecrets.headers).length) this.secrets.set(key, nextSecrets);
      else this.secrets.delete(key);
    }
    this.persistSecrets();
    return this.publicServer(stored, validated.scope, project);
  }

  remove(key: string, projectPath?: string): void {
    const server = this.list(projectPath).find((entry) => entry.key === key);
    if (!server) throw new Error("找不到该 MCP Server。");
    const filePath = server.scope === "user" ? this.userConfigPath : this.projectConfigPath(server.projectPath as string);
    const current = this.readFile(filePath);
    atomicWrite(filePath, { version: 1, servers: current.servers.filter((entry) => entry.id !== server.id) } satisfies StoredMcpFile);
    if (this.secrets.delete(key)) this.persistSecrets();
  }

  resolved(server: McpServerConfig): McpServerConfig & { secrets: McpSecrets } {
    const secrets = this.secrets.get(server.key) ?? emptySecrets();
    return {
      ...server,
      transport: server.transport.type === "stdio"
        ? { ...server.transport, environment: { ...server.transport.environment } }
        : { ...server.transport, headers: { ...server.transport.headers } },
      secrets: { environment: { ...secrets.environment }, headers: { ...secrets.headers } },
    };
  }

  private validateInput(input: SaveMcpServerInput): SaveMcpServerInput {
    if (!input || typeof input !== "object") throw new Error("MCP Server 配置格式无效。");
    const id = input.id?.trim();
    const name = input.name?.trim();
    if (!serverIdPattern.test(id)) throw new Error("MCP Server ID 只能包含字母、数字、点、下划线和短横线。");
    if (!name || name.length > 80) throw new Error("MCP Server 名称不能为空且不能超过 80 个字符。");
    if (input.scope !== "user" && input.scope !== "project") throw new Error("MCP Server 作用域无效。");
    if (input.scope === "project" && (!input.projectPath || !path.isAbsolute(input.projectPath))) throw new Error("项目级 MCP Server 需要有效的项目路径。");
    if (typeof input.enabled !== "boolean") throw new Error("MCP Server 启用状态无效。");
    const timeoutMs = Number(input.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new Error("MCP 超时必须介于 1 秒和 5 分钟之间。");

    if (input.transport?.type === "stdio") {
      const command = input.transport.command?.trim();
      if (!command || command.length > 2_048 || /[\r\n\0]/.test(command)) throw new Error("MCP stdio 命令无效。");
      if (!Array.isArray(input.transport.args) || input.transport.args.some((entry) => typeof entry !== "string" || /[\0]/.test(entry))) throw new Error("MCP stdio 参数无效。");
      const cwd = input.transport.cwd?.trim() || undefined;
      if (input.scope === "project" && cwd && (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes(".."))) {
        throw new Error("项目级 MCP stdio 工作目录必须是项目内的相对路径。");
      }
      return {
        ...input,
        id,
        name,
        timeoutMs,
        transport: {
          type: "stdio",
          command,
          args: [...input.transport.args],
          cwd,
          environment: stringRecord(input.transport.environment, "MCP 环境变量", environmentKeyPattern),
        },
      };
    }
    if (input.transport?.type === "streamable-http") {
      let url: URL;
      try {
        url = new URL(input.transport.url);
      } catch {
        throw new Error("MCP HTTP URL 无效。");
      }
      if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new Error("MCP HTTP URL 必须使用 http/https，且不能内嵌凭据。");
      return {
        ...input,
        id,
        name,
        timeoutMs,
        transport: {
          type: "streamable-http",
          url: url.toString(),
          headers: stringRecord(input.transport.headers, "MCP 请求头", headerNamePattern),
        },
      };
    }
    throw new Error("MCP 传输类型无效。");
  }

  private publicServer(server: StoredMcpServer, scope: McpServerScope, projectPath?: string): McpServerConfig {
    const key = serverKey(scope, server.id, projectPath);
    return {
      ...server,
      key,
      scope,
      projectPath,
      hasCredentials: this.secrets.has(key),
      transport: server.transport.type === "stdio"
        ? { ...server.transport, args: [...server.transport.args], environment: { ...server.transport.environment } }
        : { ...server.transport, headers: { ...server.transport.headers } },
    };
  }

  private idFromKey(key: string | undefined, scope: McpServerScope, projectPath?: string): string | undefined {
    if (!key) return undefined;
    const prefix = scope === "user" ? "user:" : `project:${canonicalPath(projectPath ?? "")}:`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
  }

  private projectConfigPath(projectPath: string): string {
    return path.join(projectPath, ".pi", "mcp.json");
  }

  private readFile(filePath: string): StoredMcpFile {
    try {
      if (!fs.existsSync(filePath)) return { version: 1, servers: [] };
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredMcpFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.servers)) return { version: 1, servers: [] };
      const servers: StoredMcpServer[] = [];
      for (const raw of parsed.servers) {
        try {
          const scope: McpServerScope = filePath === this.userConfigPath ? "user" : "project";
          const projectPath = scope === "project" ? path.dirname(path.dirname(filePath)) : undefined;
          const validated = this.validateInput({ ...raw, scope, projectPath } as SaveMcpServerInput);
          servers.push({ id: validated.id, name: validated.name, enabled: validated.enabled, timeoutMs: validated.timeoutMs, transport: validated.transport });
        } catch {
          // Ignore malformed entries while preserving the rest of the file.
        }
      }
      return { version: 1, servers };
    } catch {
      return { version: 1, servers: [] };
    }
  }

  private loadSecrets(): void {
    if (!fs.existsSync(this.credentialPath)) return;
    this.requireEncryption("无法读取已保存的 MCP 凭据");
    const stored = JSON.parse(fs.readFileSync(this.credentialPath, "utf8")) as StoredMcpCredentials;
    if (stored.version !== 1 || typeof stored.encrypted !== "string") throw new Error("MCP 凭据文件格式无效。");
    const plaintext = this.encryption.decryptString(Buffer.from(stored.encrypted, "base64"));
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Record<string, unknown>;
      try {
        const secrets = {
          environment: stringRecord(candidate.environment, "MCP 私密环境变量", environmentKeyPattern),
          headers: stringRecord(candidate.headers, "MCP 私密请求头", headerNamePattern),
        };
        if (Object.keys(secrets.environment).length || Object.keys(secrets.headers).length) this.secrets.set(key, secrets);
      } catch {
        // Ignore one malformed credential without losing the remaining servers.
      }
    }
  }

  private persistSecrets(): void {
    if (this.secrets.size === 0) {
      if (fs.existsSync(this.credentialPath)) fs.unlinkSync(this.credentialPath);
      return;
    }
    this.requireEncryption("MCP 凭据未保存");
    const plaintext = JSON.stringify(Object.fromEntries(this.secrets));
    const stored: StoredMcpCredentials = {
      version: 1,
      encrypted: this.encryption.encryptString(plaintext).toString("base64"),
    };
    atomicWrite(this.credentialPath, stored);
  }

  private requireEncryption(action: string): void {
    if (!this.encryption.isEncryptionAvailable()) throw new Error(`操作系统安全存储当前不可用，${action}。`);
  }
}
