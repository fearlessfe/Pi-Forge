import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  },
}));

import { SettingsStore, type SafeStorageLike } from "./settings-store.js";

const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

const secureStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("keeps API keys isolated by provider while switching model settings", () => {
    const store = new SettingsStore(createDirectory(), secureStorage);
    store.save({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/",
      modelId: "claude-sonnet-4-6",
      thinkingLevel: "high",
      apiKey: "anthropic-secret",
    });

    const openAiSettings = store.save({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1/",
      modelId: "gpt-5.4",
      thinkingLevel: "max",
    });
    expect(openAiSettings).toMatchObject({ provider: "openai", hasApiKey: false, thinkingLevel: "max" });
    expect(store.resolve().apiKey).toBeUndefined();

    store.save({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-5.4",
      thinkingLevel: "max",
      apiKey: "openai-secret",
    });
    expect(store.resolve().apiKey).toBe("openai-secret");

    store.save({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-6",
      thinkingLevel: "high",
    });
    expect(store.resolve().apiKey).toBe("anthropic-secret");
  });

  it("migrates the legacy single-key format to the configured provider", () => {
    const directory = createDirectory();
    fs.writeFileSync(path.join(directory, "model-settings.json"), JSON.stringify({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-6",
      thinkingLevel: "medium",
      encryptedApiKey: Buffer.from("encrypted:legacy-secret").toString("base64"),
    }));
    const store = new SettingsStore(directory, secureStorage);

    expect(store.get().hasApiKey).toBe(true);
    expect(store.resolve().apiKey).toBe("legacy-secret");
  });

  it("exposes and clears legacy encrypted API keys for CredentialStore migration", () => {
    const store = new SettingsStore(createDirectory(), secureStorage);
    store.save({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      modelId: "gemini-3.5-flash",
      thinkingLevel: "medium",
      apiKey: "gemini-secret",
    });

    expect(store.readLegacyApiKeys()).toEqual({ google: "gemini-secret" });
    store.clearLegacyApiKeys();
    expect(store.get()).toMatchObject({ provider: "google", hasApiKey: false, credentials: [] });
    expect(store.resolve().apiKey).toBeUndefined();
  });

  it("rejects invalid endpoints and refuses plaintext fallback", () => {
    const directory = createDirectory();
    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    };
    const store = new SettingsStore(directory, unavailable);

    expect(() => store.save({
      provider: "openai",
      baseUrl: "file:///tmp/model",
      modelId: "gpt-5.4",
      thinkingLevel: "medium",
    })).toThrow("API 地址仅支持 HTTP 或 HTTPS");
    expect(() => store.save({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-5.4",
      thinkingLevel: "medium",
      apiKey: "must-not-be-plaintext",
    })).toThrow("操作系统安全存储当前不可用");
    expect(fs.existsSync(path.join(directory, "model-settings.json"))).toBe(false);
  });

  it("accepts Pi built-in providers with ambient authentication and no fixed endpoint", () => {
    const store = new SettingsStore(createDirectory(), secureStorage);
    const saved = store.save({
      provider: "amazon-bedrock",
      baseUrl: "",
      modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      thinkingLevel: "medium",
    });

    expect(saved).toMatchObject({ provider: "amazon-bedrock", baseUrl: "", hasApiKey: false });
    expect(() => store.save({
      provider: "google-compatible",
      baseUrl: "",
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "medium",
    })).toThrow("兼容端点必须填写 API 地址");
  });
});
