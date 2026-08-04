import {
  DefaultPackageManager,
  SettingsManager,
  type PackageManager,
  type ProgressEvent,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  InstalledPlugin,
  PluginContentScanReport,
  PluginManifest,
  PluginPackage,
  PluginProgressEvent,
  PluginResourceType,
  PluginRiskTier,
  PluginSearchResult,
} from "../src/contracts.js";
import { scanPluginTarball } from "./plugin-content-scanner.js";
import { downloadAndVerifyPluginTarball } from "./plugin-package-verifier.js";
import { PluginSecurityStore } from "./plugin-security-store.js";

type PackageManagerPort = Pick<
  PackageManager,
  "install" | "addSourceToSettings" | "removeAndPersist" | "listConfiguredPackages" | "setProgressCallback" | "getInstalledPath"
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
  readme?: unknown;
  downloads?: { weekly?: unknown; monthly?: unknown };
  insecure?: unknown;
  pi?: unknown;
  dist?: { integrity?: unknown; shasum?: unknown; tarball?: unknown };
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
  securityStore?: PluginSecurityStore;
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

function usageExcerpt(value: unknown): string | undefined {
  const readme = text(value)?.replace(/\r\n?/g, "\n").slice(0, 50_000);
  if (!readme) return undefined;
  const lines = readme.split("\n");
  const heading = lines.findIndex((line) => /^#{1,4}\s+(usage|how to use|getting started|quick start|examples?|用法|如何使用|快速开始|入门|示例)(?:\s|$)/i.test(line.trim()));
  if (heading < 0) return undefined;
  const level = lines[heading].match(/^#+/)?.[0].length ?? 2;
  const end = lines.findIndex((line, index) => index > heading && new RegExp(`^#{1,${level}}\\s+`).test(line.trim()));
  const section = lines
    .slice(heading + 1, end > heading ? end : undefined)
    .map((line) => line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return section ? section.slice(0, 2_400) : undefined;
}

const supportedResources: PluginResourceType[] = ["extensions", "skills", "prompts", "themes"];

function validateManifest(value: unknown): PluginManifest {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("插件 pi 资源清单格式无效。");
  const record = value as Record<string, unknown>;
  const manifest: PluginManifest = {};
  for (const resource of supportedResources) {
    if (!(resource in record)) continue;
    const entries = record[resource];
    if (!Array.isArray(entries)) throw new Error(`插件 ${resource} 资源清单必须是路径数组。`);
    manifest[resource] = entries.map((entry) => {
      if (typeof entry !== "string" || !entry.trim()) throw new Error(`插件 ${resource} 包含无效资源路径。`);
      const normalized = entry.trim();
      const candidate = normalized.startsWith("!") ? normalized.slice(1) : normalized;
      if (
        !candidate
        || candidate.includes("\0")
        || path.posix.isAbsolute(candidate)
        || path.win32.isAbsolute(candidate)
        || candidate.split(/[\\/]+/).includes("..")
        || /^[a-z][a-z0-9+.-]*:/i.test(candidate)
      ) throw new Error(`插件资源路径越界：${normalized}`);
      return normalized;
    });
  }
  return manifest;
}

function hasSha512Integrity(integrity: string | undefined): boolean {
  return integrity?.trim().split(/\s+/).some((entry) => {
    const separator = entry.indexOf("-");
    if (separator <= 0 || entry.slice(0, separator).toLowerCase() !== "sha512") return false;
    try {
      return Buffer.from(entry.slice(separator + 1), "base64").length === 64;
    } catch {
      return false;
    }
  }) === true;
}

export function lifecycleSafeNpmCommand(command: string[] | undefined): string[] {
  const normalized = command?.length ? [...command] : ["npm"];
  const alreadyDisabled = normalized.some((argument) => (
    argument === "--ignore-scripts"
    || argument === "--config.ignore-scripts=true"
    || argument === "--config.ignoreScripts=true"
  ));
  return alreadyDisabled ? normalized : [...normalized, "--ignore-scripts"];
}

function riskTier(resources: PluginResourceType[], insecure: boolean, hasIntegrity: boolean): PluginRiskTier {
  if (insecure) return "blocked";
  if (!hasIntegrity) return "high";
  if (resources.includes("extensions") || resources.length === 0) return "high";
  if (resources.some((resource) => resource === "skills" || resource === "prompts")) return "medium";
  return "low";
}

function riskTierWithScan(base: PluginRiskTier, scan: PluginContentScanReport): PluginRiskTier {
  if (scan.status === "blocked") return "blocked";
  if (base === "blocked" || base === "high") return base;
  if (scan.findings.some((finding) => finding.severity === "high" || finding.severity === "critical")) return "high";
  if (base === "medium" || scan.findings.some((finding) => finding.severity === "medium")) return "medium";
  return base;
}

function normalizePackage(
  value: RegistryPackage,
  extras: { score?: unknown; downloads?: { weekly?: unknown; monthly?: unknown } } = {},
): PluginPackage | undefined {
  const name = text(value.name);
  const version = text(value.version);
  if (!name || !version) return undefined;
  const manifest = validateManifest(value.pi);
  const resources = supportedResources.filter((resource) => resource in manifest);
  const insecure = value.insecure === true;
  const integrity = text(value.dist?.integrity);
  const shasum = text(value.dist?.shasum);
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
    usage: usageExcerpt(value.readme),
    weeklyDownloads: number(extras.downloads?.weekly) ?? number(value.downloads?.weekly),
    monthlyDownloads: number(extras.downloads?.monthly) ?? number(value.downloads?.monthly),
    score: number(extras.score),
    insecure,
    resources,
    manifest,
    integrity,
    shasum,
    provenance: "npm-registry",
    riskTier: riskTier(resources, insecure, hasSha512Integrity(integrity)),
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
  private readonly securityStore: PluginSecurityStore;
  private operation: string | undefined;

  constructor(
    agentDir: string,
    cwd: string,
    private readonly emit: (event: PluginProgressEvent) => void,
    options: PluginServiceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.registryUrl = (options.registryUrl ?? "https://registry.npmjs.org").replace(/\/$/, "");
    this.securityStore = options.securityStore ?? new PluginSecurityStore(path.dirname(agentDir));
    if (options.packageManager) this.packageManager = options.packageManager;
    else {
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
      settingsManager.applyOverrides({ npmCommand: lifecycleSafeNpmCommand(settingsManager.getNpmCommand()) });
      this.packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    }
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
    return (await this.registryMetadata(name, version)).metadata;
  }

  private async registryMetadata(name: string, version: string): Promise<{ metadata: PluginPackage; tarballUrl?: string }> {
    this.validatePackage(name, version);
    const response = await this.fetchImpl(`${this.registryUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (response.status === 404) throw new Error("没有找到这个插件或版本。");
    if (!response.ok) throw new Error(`插件详情请求失败（HTTP ${response.status}）。`);
    const value = await response.json() as RegistryPackage;
    if (!isPiPackage(value)) throw new Error("该 npm 包没有声明 pi-package，已拒绝安装。");
    const metadata = normalizePackage(value);
    if (!metadata) throw new Error("插件元数据不完整，无法安装。");
    if (metadata.name !== name) throw new Error("插件注册表返回了不匹配的包名，已拒绝安装。");
    if (version !== "latest" && metadata.version !== version) throw new Error("插件注册表返回了不匹配的版本，已拒绝安装。");
    return { metadata, tarballUrl: text(value.dist?.tarball) };
  }

  listInstalled(cwd?: string): InstalledPlugin[] {
    return this.packageManager.listConfiguredPackages()
      .filter((entry) => entry.scope === "user" && entry.source.startsWith("npm:"))
      .map((entry) => {
        const parsed = parseNpmSource(entry.source);
        const installedPath = entry.installedPath ?? this.packageManager.getInstalledPath(entry.source, "user");
        const security = this.securityStore.get(entry.source);
        const verification = !installedPath
          ? "missing" as const
          : security?.provenance === "npm-registry"
            ? this.verifyInstalled(installedPath, security.name, security.version, security.manifest) ? "verified" as const : "tampered" as const
            : "legacy" as const;
        return {
          source: entry.source,
          name: parsed.name,
          version: parsed.version,
          installed: Boolean(installedPath),
          enabled: this.securityStore.isEnabled(entry.source),
          projectEnabled: cwd ? this.securityStore.isEnabled(entry.source, cwd) : undefined,
          publisher: security?.publisher,
          integrity: security?.integrity,
          provenance: security?.provenance ?? "legacy",
          riskTier: security?.riskTier ?? "high",
          resources: security?.resources ?? [],
          installedAt: security?.installedAt,
          securityScan: security?.securityScan,
          verification,
        };
      });
  }

  async install(name: string, version: string): Promise<InstalledPlugin[]> {
    return this.withOperation("安装", async () => {
      const { metadata, tarballUrl } = await this.registryMetadata(name, version);
      if (metadata.riskTier === "blocked") throw new Error("该版本被标记为存在安全风险，已阻止安装。");
      const source = `npm:${metadata.name}@${metadata.version}`;
      const tarball = await downloadAndVerifyPluginTarball(this.fetchImpl, tarballUrl, metadata.integrity, {
        name: metadata.name,
        version: metadata.version,
        manifest: metadata.manifest,
      });
      const securityScan = await scanPluginTarball(tarball);
      if (securityScan.status === "blocked") {
        const rules = [...new Set(securityScan.findings
          .filter((finding) => finding.severity === "critical" && finding.confidence === "high")
          .map((finding) => finding.ruleId))];
        throw new Error(`插件内容安全扫描发现高置信度严重风险（${rules.join(", ") || "unknown"}），已拒绝安装。`);
      }
      const installedRiskTier = riskTierWithScan(metadata.riskTier, securityScan);
      const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-plugin-install-"));
      fs.chmodSync(stagingDirectory, 0o700);
      const stagedTarball = path.join(stagingDirectory, "package.tgz");
      const replacingExistingInstall = Boolean(this.packageManager.getInstalledPath(source, "user"));
      try {
        fs.writeFileSync(stagedTarball, tarball, { mode: 0o600 });
        await this.packageManager.install(`npm:${stagedTarball}`);
      } catch (error) {
        if (!replacingExistingInstall) await this.packageManager.removeAndPersist(source);
        throw error;
      } finally {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
      }
      const installedPath = this.packageManager.getInstalledPath(source, "user")
        ?? this.packageManager.listConfiguredPackages().find((entry) => entry.source === source)?.installedPath;
      const failure = !installedPath
        ? "插件安装后的包名、版本或资源清单校验失败，已移除该插件。"
        : this.verifyInstalled(installedPath, metadata.name, metadata.version, metadata.manifest)
          ? undefined
          : "插件安装后的包名、版本或资源清单校验失败，已移除该插件。";
      if (failure) {
        await this.packageManager.removeAndPersist(source);
        throw new Error(failure);
      }
      this.packageManager.addSourceToSettings(source);
      this.securityStore.save({
        source,
        name: metadata.name,
        version: metadata.version,
        publisher: metadata.publisher,
        integrity: metadata.integrity,
        shasum: metadata.shasum,
        provenance: metadata.provenance,
        riskTier: installedRiskTier,
        resources: metadata.resources,
        manifest: metadata.manifest,
        installedAt: new Date().toISOString(),
        securityScan,
        enabled: false,
      });
      return this.listInstalled();
    });
  }

  async remove(source: string): Promise<InstalledPlugin[]> {
    if (!source.startsWith("npm:")) throw new Error("只能移除由插件中心安装的 npm 插件。");
    const installed = this.listInstalled();
    if (!installed.some((item) => item.source === source)) throw new Error("该插件未安装或安装记录已变化。");
    return this.withOperation("卸载", async () => {
      await this.packageManager.removeAndPersist(source);
      this.securityStore.remove(source);
      return this.listInstalled();
    });
  }

  setEnabled(source: string, enabled: boolean, cwd?: string, scope: "user" | "project" = "user"): InstalledPlugin[] {
    const installed = this.listInstalled().find((item) => item.source === source);
    if (!installed) throw new Error("该插件未安装或安装记录已变化。");
    if (enabled && (installed.riskTier === "blocked" || installed.securityScan?.status === "blocked")) {
      throw new Error("插件内容安全扫描已阻止启用。请移除该版本并联系发布者修复。");
    }
    if (scope === "project" && !cwd) throw new Error("项目级插件开关需要工作区路径。");
    this.securityStore.setEnabled(source, enabled, cwd, scope);
    return this.listInstalled(cwd);
  }

  dispose(): void {
    this.packageManager.setProgressCallback(undefined);
  }

  private validatePackage(name: string, version: string): void {
    if (!packageNamePattern.test(name)) throw new Error("插件包名无效。");
    if (version !== "latest" && !versionPattern.test(version)) throw new Error("插件版本无效。");
  }

  private verifyInstalled(packageRoot: string, expectedName: string, expectedVersion: string, manifest: PluginManifest): boolean {
    try {
      const root = fs.realpathSync(packageRoot);
      const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
      if (packageJson.name !== expectedName || packageJson.version !== expectedVersion) return false;
      if (JSON.stringify(validateManifest(packageJson.pi)) !== JSON.stringify(manifest)) return false;
      for (const entries of Object.values(manifest)) {
        for (const entry of entries ?? []) {
          if (entry.startsWith("!")) continue;
          const firstGlob = entry.search(/[?*{[]/);
          const stablePart = firstGlob < 0 ? entry : entry.slice(0, firstGlob);
          const relative = stablePart.replace(/[\\/]+$/, "") || ".";
          const resolved = path.resolve(root, relative);
          if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false;
          if (!fs.existsSync(resolved)) return false;
          const realResolved = fs.realpathSync(resolved);
          if (realResolved !== root && !realResolved.startsWith(`${root}${path.sep}`)) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
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
