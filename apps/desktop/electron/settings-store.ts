import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ModelSettings, ProviderId, SaveModelSettings, ThinkingLevel } from "../src/contracts.js";

type ModelConfiguration = Omit<ModelSettings, "hasApiKey" | "configuredProviders">;

type StoredSettings = ModelConfiguration & {
  encryptedApiKeys: Partial<Record<ProviderId, string>>;
};

type StoredSettingsFile = Partial<StoredSettings> & {
  /** v1 migration field. */
  encryptedApiKey?: string;
};

export type SafeStorageLike = Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">;

const defaults: StoredSettings = {
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-sonnet-4-6",
  thinkingLevel: "medium",
  encryptedApiKeys: {},
};

const providers = new Set<ProviderId>(["anthropic", "openai", "openai-compatible"]);
const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class SettingsStore {
  private readonly filePath: string;

  constructor(userDataPath: string, private readonly secureStorage: SafeStorageLike = safeStorage) {
    this.filePath = path.join(userDataPath, "model-settings.json");
  }

  get(): ModelSettings {
    const stored = this.read();
    return {
      provider: stored.provider,
      baseUrl: stored.baseUrl,
      modelId: stored.modelId,
      thinkingLevel: stored.thinkingLevel,
      hasApiKey: Boolean(stored.encryptedApiKeys[stored.provider]),
      configuredProviders: [...providers].filter((provider) => Boolean(stored.encryptedApiKeys[provider])),
    };
  }

  save(input: SaveModelSettings): ModelSettings {
    const next = this.validate(input);
    const current = this.read();
    const encryptedApiKeys = { ...current.encryptedApiKeys };

    if (input.apiKey?.trim()) {
      this.requireEncryption("API Key 未保存");
      encryptedApiKeys[next.provider] = this.secureStorage.encryptString(input.apiKey.trim()).toString("base64");
    }

    const stored: StoredSettings = { ...next, encryptedApiKeys };
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    return this.get();
  }

  resolve(input?: SaveModelSettings): ModelConfiguration & { apiKey?: string } {
    const stored = this.read();
    const validated = input ? this.validate(input) : this.configuration(stored);
    let apiKey = input?.apiKey?.trim();
    const encryptedApiKey = stored.encryptedApiKeys[validated.provider];

    if (!apiKey && encryptedApiKey) {
      this.requireEncryption("无法读取 API Key");
      apiKey = this.secureStorage.decryptString(Buffer.from(encryptedApiKey, "base64"));
    }

    return { ...validated, apiKey };
  }

  private read(): StoredSettings {
    try {
      if (!fs.existsSync(this.filePath)) return defaults;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as StoredSettingsFile;
      const configuration = this.validate({ ...defaults, ...parsed });
      const encryptedApiKeys: Partial<Record<ProviderId, string>> = {};
      for (const provider of providers) {
        const encrypted = parsed.encryptedApiKeys?.[provider];
        if (typeof encrypted === "string" && encrypted) encryptedApiKeys[provider] = encrypted;
      }
      if (typeof parsed.encryptedApiKey === "string" && !encryptedApiKeys[configuration.provider]) {
        encryptedApiKeys[configuration.provider] = parsed.encryptedApiKey;
      }
      return { ...configuration, encryptedApiKeys };
    } catch {
      return defaults;
    }
  }

  private configuration(stored: StoredSettings): ModelConfiguration {
    return {
      provider: stored.provider,
      baseUrl: stored.baseUrl,
      modelId: stored.modelId,
      thinkingLevel: stored.thinkingLevel,
    };
  }

  private requireEncryption(action: string): void {
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new Error(`操作系统安全存储当前不可用，${action}。`);
    }
  }

  private validate(input: Omit<SaveModelSettings, "apiKey"> | SaveModelSettings): ModelConfiguration {
    if (!providers.has(input.provider)) throw new Error("不支持的模型提供商。");
    if (!thinkingLevels.has(input.thinkingLevel)) throw new Error("不支持的 thinking 级别。");
    if (!input.modelId?.trim()) throw new Error("模型 ID 不能为空。");

    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      throw new Error("API 地址格式不正确。");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("API 地址仅支持 HTTP 或 HTTPS。");
    }

    return {
      provider: input.provider,
      baseUrl: input.baseUrl.replace(/\/$/, ""),
      modelId: input.modelId.trim(),
      thinkingLevel: input.thinkingLevel,
    };
  }
}
