import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ObservabilitySettings,
  OtlpTraceExporterSettings,
  SaveObservabilitySettings,
  TraceCaptureContent,
} from "../src/contracts.js";

type StoredExporter = Omit<OtlpTraceExporterSettings, "hasHeaders"> & {
  encryptedHeaders?: string;
};

type StoredSettings = Omit<ObservabilitySettings, "exporters"> & {
  version: 1;
  exporters: StoredExporter[];
};

export type ResolvedOtlpTraceExporter = Omit<OtlpTraceExporterSettings, "hasHeaders"> & {
  headers: Record<string, string>;
};

export type ResolvedObservabilitySettings = Omit<ObservabilitySettings, "exporters"> & {
  exporters: ResolvedOtlpTraceExporter[];
};

export type ObservabilitySafeStorage = Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">;

const captureModes = new Set<TraceCaptureContent>(["none", "metadata", "full"]);
const defaults: StoredSettings = {
  version: 1,
  enabled: true,
  serviceName: "pi-forge",
  captureContent: "metadata",
  localFileEnabled: true,
  exporters: [],
};

function publicExporter(exporter: StoredExporter): OtlpTraceExporterSettings {
  return {
    id: exporter.id,
    name: exporter.name,
    endpoint: exporter.endpoint,
    enabled: exporter.enabled,
    hasHeaders: Boolean(exporter.encryptedHeaders),
  };
}

function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    if (!key || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error(`Trace 请求头名称无效：${rawKey}`);
    if (typeof rawValue !== "string" || /[\r\n]/.test(rawValue)) throw new Error(`Trace 请求头值无效：${key}`);
    result[key] = rawValue.trim();
  }
  return result;
}

function validateEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error("OTLP Endpoint 格式不正确。");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("OTLP Endpoint 仅支持 HTTP 或 HTTPS。");
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

export class ObservabilityStore {
  private readonly filePath: string;

  constructor(userDataPath: string, private readonly secureStorage: ObservabilitySafeStorage = safeStorage) {
    this.filePath = path.join(userDataPath, "observability-settings.json");
  }

  get(): ObservabilitySettings {
    const stored = this.read();
    return {
      enabled: stored.enabled,
      serviceName: stored.serviceName,
      captureContent: stored.captureContent,
      localFileEnabled: stored.localFileEnabled,
      exporters: stored.exporters.map(publicExporter),
    };
  }

  resolve(): ResolvedObservabilitySettings {
    const stored = this.read();
    return {
      enabled: stored.enabled,
      serviceName: stored.serviceName,
      captureContent: stored.captureContent,
      localFileEnabled: stored.localFileEnabled,
      exporters: stored.exporters.map((exporter) => ({
        id: exporter.id,
        name: exporter.name,
        endpoint: exporter.endpoint,
        enabled: exporter.enabled,
        headers: this.decryptHeaders(exporter.encryptedHeaders),
      })),
    };
  }

  save(input: SaveObservabilitySettings): ObservabilitySettings {
    const serviceName = input.serviceName.trim();
    if (!serviceName || serviceName.length > 128) throw new Error("Trace Service Name 必须为 1 到 128 个字符。");
    if (!captureModes.has(input.captureContent)) throw new Error("Trace 内容采集模式无效。");
    if (!Array.isArray(input.exporters) || input.exporters.length > 12) throw new Error("最多可以配置 12 个 OTLP Exporter。");

    const current = this.read();
    const existing = new Map(current.exporters.map((exporter) => [exporter.id, exporter]));
    const seen = new Set<string>();
    const exporters = input.exporters.map((candidate): StoredExporter => {
      const id = candidate.id?.trim() || randomUUID();
      if (seen.has(id)) throw new Error("OTLP Exporter ID 重复。");
      seen.add(id);
      const name = candidate.name.trim();
      if (!name || name.length > 80) throw new Error("OTLP Exporter 名称必须为 1 到 80 个字符。");
      let encryptedHeaders = existing.get(id)?.encryptedHeaders;
      if (candidate.headers !== undefined) {
        const headers = validateHeaders(candidate.headers);
        encryptedHeaders = Object.keys(headers).length === 0 ? undefined : this.encryptHeaders(headers);
      }
      return {
        id,
        name,
        endpoint: validateEndpoint(candidate.endpoint),
        enabled: candidate.enabled,
        encryptedHeaders,
      };
    });

    this.write({
      version: 1,
      enabled: input.enabled,
      serviceName,
      captureContent: input.captureContent,
      localFileEnabled: input.localFileEnabled,
      exporters,
    });
    return this.get();
  }

  private encryptHeaders(headers: Record<string, string>): string {
    if (!this.secureStorage.isEncryptionAvailable()) throw new Error("操作系统安全存储当前不可用，Trace 请求头未保存。");
    return this.secureStorage.encryptString(JSON.stringify(headers)).toString("base64");
  }

  private decryptHeaders(encrypted?: string): Record<string, string> {
    if (!encrypted) return {};
    try {
      if (!this.secureStorage.isEncryptionAvailable()) return {};
      const parsed = JSON.parse(this.secureStorage.decryptString(Buffer.from(encrypted, "base64"))) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? validateHeaders(parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  private read(): StoredSettings {
    try {
      if (!fs.existsSync(this.filePath)) return defaults;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredSettings>;
      if (parsed.version !== 1) return defaults;
      const serviceName = typeof parsed.serviceName === "string" && parsed.serviceName.trim() ? parsed.serviceName.trim().slice(0, 128) : defaults.serviceName;
      const captureContent = captureModes.has(parsed.captureContent as TraceCaptureContent)
        ? parsed.captureContent as TraceCaptureContent
        : defaults.captureContent;
      const exporters = Array.isArray(parsed.exporters) ? parsed.exporters.flatMap((value): StoredExporter[] => {
        if (!value || typeof value !== "object") return [];
        const exporter = value as Partial<StoredExporter>;
        if (typeof exporter.id !== "string" || typeof exporter.name !== "string" || typeof exporter.endpoint !== "string") return [];
        try {
          return [{
            id: exporter.id,
            name: exporter.name,
            endpoint: validateEndpoint(exporter.endpoint),
            enabled: exporter.enabled === true,
            encryptedHeaders: typeof exporter.encryptedHeaders === "string" ? exporter.encryptedHeaders : undefined,
          }];
        } catch {
          return [];
        }
      }).slice(0, 12) : [];
      return {
        version: 1,
        enabled: parsed.enabled !== false,
        serviceName,
        captureContent,
        localFileEnabled: parsed.localFileEnabled !== false,
        exporters,
      };
    } catch {
      return defaults;
    }
  }

  private write(value: StoredSettings): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
