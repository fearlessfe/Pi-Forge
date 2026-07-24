import fs from "node:fs";
import path from "node:path";
import type {
  ModelCatalogEntry,
  ModelMetadataOverride,
  ProviderCatalogEntry,
  ProviderId,
} from "../src/contracts.js";

type StoredMetadata = {
  version: 1;
  overrides: Record<ProviderId, Record<string, ModelMetadataOverride>>;
};

const emptyMetadata: StoredMetadata = { version: 1, overrides: {} };

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} 必须是大于或等于 0 的数字。`);
  }
  return value;
}

function validIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\u0000-\u001f]/.test(trimmed)) throw new Error(`${field}格式无效。`);
  return trimmed;
}

export class ModelMetadataStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "model-metadata.json");
  }

  get(providerId: ProviderId, modelId: string): ModelMetadataOverride | undefined {
    return this.read().overrides[providerId]?.[modelId];
  }

  apply(catalog: ProviderCatalogEntry[]): ProviderCatalogEntry[] {
    const overrides = this.read().overrides;
    return catalog.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => this.applyModel(model, overrides[provider.id]?.[model.id])),
    }));
  }

  save(providerId: ProviderId, modelId: string, value: ModelMetadataOverride): void {
    const provider = validIdentifier(providerId, "模型提供商");
    const model = validIdentifier(modelId, "模型 ID");
    const metadata = this.validate(value);
    const stored = this.read();
    this.write({
      version: 1,
      overrides: {
        ...stored.overrides,
        [provider]: { ...stored.overrides[provider], [model]: metadata },
      },
    });
  }

  reset(providerId: ProviderId, modelId: string): void {
    const stored = this.read();
    const providerOverrides = { ...stored.overrides[providerId] };
    if (!(modelId in providerOverrides)) return;
    delete providerOverrides[modelId];
    const overrides = { ...stored.overrides };
    if (Object.keys(providerOverrides).length === 0) delete overrides[providerId];
    else overrides[providerId] = providerOverrides;
    this.write({ version: 1, overrides });
  }

  private applyModel(model: ModelCatalogEntry, override?: ModelMetadataOverride): ModelCatalogEntry {
    if (!override) return { ...model, isMetadataOverridden: false };
    return {
      ...model,
      name: override.name,
      contextWindow: override.contextWindow,
      maxOutputTokens: override.maxOutputTokens,
      pricing: override.pricing,
      isMetadataOverridden: true,
    };
  }

  private validate(value: ModelMetadataOverride): ModelMetadataOverride {
    if (!value || typeof value !== "object") throw new Error("模型元信息格式无效。");
    const name = value.name?.trim();
    if (!name || name.length > 256) throw new Error("模型名称不能为空且不能超过 256 个字符。");
    return {
      name,
      contextWindow: finiteNonNegative(value.contextWindow, "上下文窗口"),
      maxOutputTokens: finiteNonNegative(value.maxOutputTokens, "最大输出"),
      pricing: {
        input: finiteNonNegative(value.pricing?.input, "输入价格"),
        output: finiteNonNegative(value.pricing?.output, "输出价格"),
        cacheRead: finiteNonNegative(value.pricing?.cacheRead, "缓存读取价格"),
        cacheWrite: finiteNonNegative(value.pricing?.cacheWrite, "缓存写入价格"),
      },
    };
  }

  private read(): StoredMetadata {
    try {
      if (!fs.existsSync(this.filePath)) return emptyMetadata;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredMetadata>;
      if (parsed.version !== 1 || !parsed.overrides || typeof parsed.overrides !== "object") return emptyMetadata;
      const overrides: StoredMetadata["overrides"] = {};
      for (const [providerId, models] of Object.entries(parsed.overrides)) {
        if (!models || typeof models !== "object") continue;
        for (const [modelId, metadata] of Object.entries(models)) {
          try {
            const validated = this.validate(metadata as ModelMetadataOverride);
            (overrides[providerId] ??= {})[modelId] = validated;
          } catch {
            // Ignore one malformed override without hiding the rest of the file.
          }
        }
      }
      return { version: 1, overrides };
    } catch {
      return emptyMetadata;
    }
  }

  private write(stored: StoredMetadata): void {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
