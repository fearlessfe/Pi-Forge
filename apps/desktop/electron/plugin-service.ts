import {
  DefaultPackageManager,
  SettingsManager,
  type PackageManager,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  InstalledPlugin,
  PluginPackage,
  PluginProgressEvent,
  PluginResourceType,
  PluginSearchResult,
} from "../src/contracts.js";

type PackageManagerPort = Pick<
  PackageManager,
  "installAndPersist" | "removeAndPersist" | "listConfiguredPackages" | "setProgressCallback" | "getInstalledPath"
>;

type RegistryPackage = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  keywords?: unknown;
  publisher?: { username?: unknown; name?: unknown };
  author?: { name?: unknown } | string;
  license?: unknown;
  date?: unknown;
  links?: { npm?: unknown; repository?: unknown; homepage?: unknown };
  repository?: { url?: unknown } | string;
  homepage?: unknown;
  downloads?: { weekly?: unknown; monthly?: unknown };
  insecure?: unknown;
  pi?: unknown;
};

type RegistrySearchResponse = {
  total?: unknown;
  objects?: Array<{
    package?: RegistryPackage;
    score?: { final?: unknown };
    downloads?: { weekly?: unknown; monthly?: unknown };
  }>;
};

type PluginServiceOptions = {
  fetch?: typeof fetch;
  registryUrl?: string;
  packageManager?: PackageManagerPort;
};

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function keywords(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? value.split(/[ ,]+/).filter(Boolean) : [];
}

function isPiPackage(value: RegistryPackage): boolean {
  return keywords(value.keywords).some((keyword) => keyword.toLowerCase() === "pi-package");
}

function repositoryUrl(value: RegistryPackage): string | undefined {
  const raw = typeof value.repository === "string" ? value.repository : text(value.repository?.url);
  return text(value.links?.repository) ?? raw?.replace(/^git\+/, "").replace(/\.git$/, "");
}

function resourceTypes(manifest: unknown): PluginResourceType[] {
  if (!manifest || typeof manifest !== "object") return [];
  const record = manifest as Record<string, unknown>;
  return (["extensions", "skills", "prompts", "themes"] as PluginResourceType[])
    .filter((key) => key in record);
}

function normalizePackage(
  value: RegistryPackage,
  extras: { score?: unknown; downloads?: { weekly?: unknown; monthly?: unknown } } = {},
): PluginPackage | undefined {
  const name = text(value.name);
  const version = text(value.version);
  if (!name || !version) return undefined;
  const resources = resourceTypes(value.pi);
  return {
    name,
    version,
    description: text(value.description) ?? "暂无描述",
    publisher: text(value.publisher?.username)
      ?? text(value.publisher?.name)
      ?? (typeof value.author === "string" ? text(value.author) : text(value.author?.name))
      ?? "未知发布者",
    license: text(value.license),
    updatedAt: text(value.date),
    npmUrl: text(value.links?.npm) ?? `https://www.npmjs.com/package/${name}`,
    repositoryUrl: repositoryUrl(value),
    homepageUrl: text(value.links?.homepage) ?? text(value.homepage),
    weeklyDownloads: number(extras.downloads?.weekly) ?? number(value.downloads?.weekly),
    monthlyDownloads: number(extras.downloads?.monthly) ?? number(value.downloads?.monthly),
    score: number(extras.score),
    insecure: value.insecure === true,
    resources,
    compatibility: resources.includes("extensions") ? "review" : resources.length > 0 ? "desktop" : "unknown",
  };
}

function parseNpmSource(source: string): { name: string; version?: string } {
  const spec = source.startsWith("npm:") ? source.slice(4) : source;
  const versionSeparator = spec.lastIndexOf("@");
  if (versionSeparator > 0) return { name: spec.slice(0, versionSeparator), version: spec.slice(versionSeparator + 1) };
  return { name: spec };
}

export class PluginService {
  private readonly fetchImpl: typeof fetch;
  private readonly registryUrl: string;
  private readonly packageManager: PackageManagerPort;
  private operation: string | undefined;

  constructor(
    agentDir: string,
    cwd: string,
    private readonly emit: (event: PluginProgressEvent) => void,
    options: PluginServiceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.registryUrl = (options.registryUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");
    this.packageManager = options.packageManager ?? new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
    });
    this.packageManager.setProgressCallback((event: ProgressEvent) => this.emit(event));
  }

  async search(query: string, offset = 0): Promise<PluginSearchResult> {
    const normalizedQuery = query.trim().slice(0, 100);
    const safeOffset = Number.isInteger(offset) ? Math.max(0, Math.min(offset, 1_000)) : 0;
    const params = new URLSearchParams({
      text: `keywords:pi-package${normalizedQuery ? ` ${normalizedQuery}` : ""}`,
      size: "24",
      from: String(safeOffset),
    });
    const response = await this.fetchImpl(`${this.registryUrl}/-/v1/search?${params}`);
    if (!response.ok) throw new Error(`插件目录请求失败（HTTP ${response.status}）。`);
    const body = await response.json() as RegistrySearchResponse;
    const packages = (body.objects ?? []).flatMap((entry) => {
      if (!entry.package || !isPiPackage(entry.package)) return [];
      const normalized = normalizePackage(entry.package, {
        score: entry.score?.final,
        downloads: entry.downloads,
      });
      return normalized ? [normalized] : [];
    });
    return { packages, total: number(body.total) ?? packages.length, offset: safeOffset };
  }

  async details(name: string, version = "latest"): Promise<PluginPackage> {
    this.validatePackage(name, version);
    const response = await this.fetchImpl(`${this.registryUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (response.status === 404) throw new Error("没有找到这个插件或版本。");
    if (!response.ok) throw new Error(`插件详情请求失败（HTTP ${response.status}）。`);
    const value = await response.json() as RegistryPackage;
    if (!isPiPackage(value)) throw new Error("该 npm 包没有声明 pi-package，已拒绝安装。");
    const normalized = normalizePackage(value);
    if (!normalized) throw new Error("插件元数据不完整，无法安装。");
    return normalized;
  }

  listInstalled(): InstalledPlugin[] {
    return this.packageManager.listConfiguredPackages()
      .filter((entry) => entry.scope === "user" && entry.source.startsWith("npm:"))
      .map((entry) => {
        const parsed = parseNpmSource(entry.source);
        return {
          source: entry.source,
          name: parsed.name,
          version: parsed.version,
          installed: Boolean(entry.installedPath ?? this.packageManager.getInstalledPath(entry.source, "user")),
        };
      });
  }

  async install(name: string, version: string): Promise<InstalledPlugin[]> {
    return this.withOperation("安装", async () => {
      const metadata = await this.details(name, version);
      await this.packageManager.installAndPersist(`npm:${metadata.name}@${metadata.version}`);
      return this.listInstalled();
    });
  }

  async remove(source: string): Promise<InstalledPlugin[]> {
    if (!source.startsWith("npm:")) throw new Error("只能移除由插件中心安装的 npm 插件。");
    const installed = this.listInstalled();
    if (!installed.some((item) => item.source === source)) throw new Error("该插件未安装或安装记录已变化。");
    return this.withOperation("卸载", async () => {
      await this.packageManager.removeAndPersist(source);
      return this.listInstalled();
    });
  }

  dispose(): void {
    this.packageManager.setProgressCallback(undefined);
  }

  private validatePackage(name: string, version: string): void {
    if (!packageNamePattern.test(name)) throw new Error("插件包名无效。");
    if (version !== "latest" && !versionPattern.test(version)) throw new Error("插件版本无效。");
  }

  private async withOperation<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (this.operation) throw new Error(`正在${this.operation}另一个插件，请稍候。`);
    this.operation = label;
    try {
      return await action();
    } finally {
      this.operation = undefined;
    }
  }
}
