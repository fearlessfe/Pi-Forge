import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, CredentialStore } from "@earendil-works/pi-ai";
import type { ModelCatalogEntry, ProviderCatalogEntry, SaveModelSettings } from "../src/contracts.js";
import {
  buildProtocolModelMetadataIndex,
  fixedProtocolModelMetadata,
  matchProtocolModelMetadata,
} from "./model-metadata-catalog.js";
import type { ModelMetadataStore } from "./model-metadata-store.js";
import { errorMessage } from "./error-message.js";

export const officialMetadataSources: Record<string, string> = {
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  openai: "https://developers.openai.com/api/docs/pricing",
  "openai-codex": "https://developers.openai.com/api/docs/pricing",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  xai: "https://docs.x.ai/developers/models",
  groq: "https://groq.com/pricing",
  mistral: "https://mistral.ai/pricing",
  openrouter: "https://openrouter.ai/models",
  deepseek: "https://api-docs.deepseek.com/quick_start/pricing",
  "amazon-bedrock": "https://aws.amazon.com/bedrock/pricing/",
  "azure-openai-responses": "https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/",
  "google-vertex": "https://cloud.google.com/vertex-ai/generative-ai/pricing",
};

export type CompatibleProviderDefinition = {
  name: string;
  api: Api;
  baseUrl: string;
  defaultModel: string;
  authHeader: boolean;
};

export const compatibleProviderDefinitions: Record<string, CompatibleProviderDefinition> = {
  "openai-compatible": {
    name: "OpenAI Completions Compatible",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen3-coder",
    authHeader: true,
  },
  "openai-responses-compatible": {
    name: "OpenAI Responses Compatible",
    api: "openai-responses",
    baseUrl: "http://127.0.0.1:8000/v1",
    defaultModel: "gpt-5",
    authHeader: true,
  },
  "anthropic-compatible": {
    name: "Anthropic Messages Compatible",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:8000",
    defaultModel: "claude-sonnet-4-6",
    authHeader: false,
  },
  "google-compatible": {
    name: "Google Generative AI Compatible",
    api: "google-generative-ai",
    baseUrl: "http://127.0.0.1:8000/v1beta",
    defaultModel: "gemini-3-flash-preview",
    authHeader: false,
  },
};

type DiscoveredModelsFile = {
  version: 1 | 2;
  providers: Record<string, { baseUrl: string; updatedAt: string; models: ModelCatalogEntry[] }>;
};

function modelEndpoint(provider: string, baseUrl: string): URL {
  const endpoint = new URL(baseUrl);
  const pathName = endpoint.pathname.replace(/\/$/, "");
  if (provider === "anthropic-compatible" && !pathName.endsWith("/v1")) {
    endpoint.pathname = `${pathName}/v1/models`;
  } else {
    endpoint.pathname = `${pathName}/models`;
  }
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function parseDiscoveredModels(payload: unknown, protocol: string): ModelCatalogEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(payload)
        ? payload
        : [];
  const models = candidates.flatMap((candidate): ModelCatalogEntry[] => {
    if (typeof candidate === "string") {
      const id = candidate.replace(/^models\//, "");
      const matched = fixedProtocolModelMetadata(protocol, id);
      return [{ id, name: id, reasoning: true, protocol, contextWindow: matched?.contextWindow ?? 0 }];
    }
    if (!candidate || typeof candidate !== "object") return [];
    const entry = candidate as Record<string, unknown>;
    const rawId = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
    const id = rawId.replace(/^models\//, "").trim();
    if (!id) return [];
    const name = typeof entry.display_name === "string"
      ? entry.display_name
      : typeof entry.displayName === "string"
        ? entry.displayName
        : id;
    const advertisedContextWindow = [entry.contextWindow, entry.context_window, entry.max_context_length]
      .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const matched = fixedProtocolModelMetadata(protocol, id);
    return [{
      id,
      name,
      reasoning: true,
      protocol,
      contextWindow: advertisedContextWindow ?? matched?.contextWindow ?? 0,
      ...(endpointDeclaresTextOnly(entry) ? { supportsImages: false } : {}),
    }];
  });
  return [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

// OpenRouter-style `architecture.input_modalities` or a `modalities.input` array
// explicitly listing modalities without "image" means the endpoint is text-only.
function endpointDeclaresTextOnly(entry: Record<string, unknown>): boolean {
  const architecture = entry.architecture;
  const inputModalities = architecture && typeof architecture === "object"
    ? (architecture as Record<string, unknown>).input_modalities
    : undefined;
  const modalities = entry.modalities;
  const modalitiesInput = modalities && typeof modalities === "object"
    ? (modalities as Record<string, unknown>).input
    : undefined;
  for (const value of [inputModalities, modalitiesInput]) {
    if (Array.isArray(value) && value.every((item) => typeof item === "string") && !value.includes("image")) return true;
  }
  return false;
}

export class ModelCatalog {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly agentDir: string,
    private readonly modelMetadata: ModelMetadataStore,
  ) {}

  async getModelCatalog(allowNetwork = true): Promise<ProviderCatalogEntry[]> {
    const runtime = await ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: path.join(this.agentDir, "models.json"),
      modelsStorePath: path.join(this.agentDir, "models-store.json"),
      allowModelNetwork: allowNetwork,
      modelRefreshTimeoutMs: 8_000,
    });
    const builtins = runtime.getProviders().map((provider): ProviderCatalogEntry => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? "",
      kind: "builtin",
      supportsApiKey: Boolean(provider.auth.apiKey),
      supportsOAuth: Boolean(provider.auth.oauth),
      oauthName: provider.auth.oauth?.name,
      models: provider.getModels().map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        protocol: model.api,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        pricing: { ...model.cost },
        supportsImages: model.input.includes("image"),
        metadataSource: "official",
        metadataSourceUrl: officialMetadataSources[provider.id],
      })),
    }));
    const protocolMetadata = buildProtocolModelMetadataIndex(builtins.flatMap((provider) => provider.models));
    const discoveredModels = this.readDiscoveredModels();
    const compatible = Object.entries(compatibleProviderDefinitions).map(([id, definition]): ProviderCatalogEntry => {
      const discovered = discoveredModels[id];
      const defaultMetadata = matchProtocolModelMetadata(protocolMetadata, definition.api, definition.defaultModel);
      const models = discovered?.models ?? [{
        id: definition.defaultModel,
        name: definition.defaultModel,
        reasoning: true,
        protocol: definition.api,
        contextWindow: defaultMetadata?.contextWindow ?? 0,
      }];
      return {
        id,
        name: definition.name,
        baseUrl: definition.baseUrl,
        kind: "compatible",
        supportsApiKey: true,
        supportsOAuth: false,
        models: models.map((model) => {
          const matched = matchProtocolModelMetadata(protocolMetadata, definition.api, model.id);
          return {
            ...model,
            protocol: definition.api,
            contextWindow: model.contextWindow || matched?.contextWindow || 0,
            maxOutputTokens: model.maxOutputTokens
              || matched?.maxOutputTokens
              || 0,
            pricing: matched?.pricing
              ?? model.pricing
              ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            // Unknown custom endpoints stay allowed; the API error surfaces if wrong.
            supportsImages: model.supportsImages ?? matched?.supportsImages ?? true,
            metadataSource: matched ? "official" : "endpoint",
            metadataSourceUrl: matched?.sourceUrl,
            metadataUpdatedAt: discovered?.updatedAt,
          };
        }),
      };
    });
    return this.modelMetadata.apply([...builtins, ...compatible]);
  }

  async discoverModels(input: SaveModelSettings): Promise<ModelCatalogEntry[]> {
    const compatible = compatibleProviderDefinitions[input.provider];
    if (!compatible) {
      const provider = (await this.getModelCatalog(false)).find((entry) => entry.id === input.provider);
      if (!provider) throw new Error(`Pi SDK 中不存在 provider：${input.provider}。`);
      return provider.models;
    }

    let endpoint: URL;
    try {
      endpoint = modelEndpoint(input.provider, input.baseUrl);
    } catch {
      throw new Error("请先填写有效的 API 地址。");
    }
    const storedCredential = await this.credentials.read(input.provider);
    const apiKey = input.apiKey?.trim() || (storedCredential?.type === "api_key" ? storedCredential.key : undefined);
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) {
      if (input.provider === "anthropic-compatible") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else if (input.provider === "google-compatible") {
        headers["x-goog-api-key"] = apiKey;
      } else {
        headers.authorization = `Bearer ${apiKey}`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "GET", headers, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("获取模型超时，请检查 API 地址和网络连接。");
      throw new Error(`无法连接模型端点：${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`获取模型失败：服务返回 HTTP ${response.status}。请检查 URL 和 API Key。`);
    const body = await response.text();
    if (body.length > 10_000_000) throw new Error("模型列表响应过大，已拒绝处理。");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("模型端点没有返回有效的 JSON。");
    }
    const models = parseDiscoveredModels(payload, compatible.api);
    if (models.length === 0) throw new Error("模型端点返回成功，但没有找到任何模型。");
    this.writeDiscoveredModels(input.provider, input.baseUrl, models);
    return models;
  }

  readDiscoveredModels(): DiscoveredModelsFile["providers"] {
    try {
      const filePath = path.join(this.agentDir, "discovered-models.json");
      if (!fs.existsSync(filePath)) return {};
      const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DiscoveredModelsFile>;
      if ((stored.version !== 1 && stored.version !== 2) || !stored.providers || typeof stored.providers !== "object") return {};
      const providers: DiscoveredModelsFile["providers"] = {};
      for (const [providerId, entry] of Object.entries(stored.providers)) {
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.models)) continue;
        const protocol = compatibleProviderDefinitions[providerId]?.api;
        const models = entry.models.filter((model): model is ModelCatalogEntry => (
          Boolean(model)
          && typeof model.id === "string"
          && typeof model.name === "string"
          && typeof model.reasoning === "boolean"
        )).map((model) => {
          const knownContextWindow = protocol ? fixedProtocolModelMetadata(protocol, model.id)?.contextWindow : undefined;
          const storedContextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : 0;
          // Version 1 used 128K as an unconditional fallback, so that value is
          // not trustworthy unless the model is now covered by known metadata.
          const contextWindow = knownContextWindow ?? (stored.version === 1 && storedContextWindow === 128_000 ? 0 : storedContextWindow);
          return { ...model, protocol: model.protocol ?? protocol, contextWindow };
        });
        if (models.length === 0) continue;
        providers[providerId] = {
          baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
          models,
        };
      }
      return providers;
    } catch {
      return {};
    }
  }

  private writeDiscoveredModels(providerId: string, baseUrl: string, models: ModelCatalogEntry[]): void {
    const filePath = path.join(this.agentDir, "discovered-models.json");
    const temporaryPath = `${filePath}.tmp`;
    const providers = this.readDiscoveredModels();
    providers[providerId] = { baseUrl: baseUrl.replace(/\/$/, ""), updatedAt: new Date().toISOString(), models };
    fs.mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 2, providers } satisfies DiscoveredModelsFile, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  }
}
