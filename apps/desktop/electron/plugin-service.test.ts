import { describe, expect, it, vi } from "vitest";
import type { PackageManager, ProgressCallback } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginService } from "./plugin-service.js";
import { PluginSecurityStore } from "./plugin-security-store.js";

type PackageManagerPort = Pick<
  PackageManager,
  "installAndPersist" | "removeAndPersist" | "listConfiguredPackages" | "setProgressCallback" | "getInstalledPath"
>;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tempDirectory(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-desktop-${name}-`));
}

function fakePackageManager(manifest: Record<string, string[]> = { extensions: ["./extension.ts"], skills: ["./skills"] }): PackageManagerPort & { progress?: ProgressCallback } {
  const configured: Array<{ source: string; scope: "user"; filtered: boolean; installedPath?: string }> = [];
  const installRoot = tempDirectory("plugins");
  return {
    progress: undefined,
    setProgressCallback(callback) { this.progress = callback; },
    listConfiguredPackages: () => configured,
    getInstalledPath: (source) => configured.find((entry) => entry.source === source)?.installedPath,
    installAndPersist: vi.fn(async (source: string) => {
      const spec = source.slice(4);
      const separator = spec.lastIndexOf("@");
      const name = spec.slice(0, separator);
      const version = spec.slice(separator + 1);
      const installedPath = path.join(installRoot, Buffer.from(source).toString("hex"));
      fs.mkdirSync(installedPath, { recursive: true });
      fs.writeFileSync(path.join(installedPath, "package.json"), JSON.stringify({ name, version, pi: manifest }));
      for (const entries of Object.values(manifest)) {
        for (const entry of entries) {
          if (entry.includes("*") || entry.startsWith("!")) continue;
          const target = path.join(installedPath, entry);
          if (path.extname(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, "export default {};");
          } else fs.mkdirSync(target, { recursive: true });
        }
      }
      configured.push({ source, scope: "user", filtered: false, installedPath });
    }),
    removeAndPersist: vi.fn(async (source: string) => {
      const index = configured.findIndex((entry) => entry.source === source);
      if (index < 0) return false;
      configured.splice(index, 1);
      return true;
    }),
  };
}

describe("PluginService", () => {
  it("searches only tagged pi packages and maps registry metadata", async () => {
    const fetchMock = vi.fn(async () => response({
      total: 2,
      objects: [
        {
          package: {
            name: "pi-example",
            version: "1.2.3",
            description: "Example",
            keywords: ["pi-package"],
            publisher: { username: "alice" },
            date: "2026-07-20T00:00:00.000Z",
          },
          score: { final: 0.92 },
          downloads: { weekly: 120 },
        },
        { package: { name: "not-pi", version: "1.0.0", keywords: ["other"] } },
      ],
    }));
    const service = new PluginService("/agent", "/cwd", () => {}, {
      fetch: fetchMock as typeof fetch,
      packageManager: fakePackageManager(),
    });

    const result = await service.search("browser");

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("keywords%3Api-package+browser"));
    expect(result.packages).toEqual([expect.objectContaining({
      name: "pi-example",
      version: "1.2.3",
      publisher: "alice",
      weeklyDownloads: 120,
      score: 0.92,
    })]);
  });

  it("validates metadata, installs an exact version and persists it", async () => {
    const manager = fakePackageManager();
    const fetchMock = vi.fn(async () => response({
      name: "@demo/pi-tools",
      version: "2.0.1",
      keywords: ["pi-package"],
      pi: { extensions: ["./extension.ts"], skills: ["./skills"] },
    }));
    const service = new PluginService("/agent", "/cwd", () => {}, {
      fetch: fetchMock as typeof fetch,
      packageManager: manager,
      securityStore: new PluginSecurityStore(tempDirectory("plugin-security")),
    });

    const installed = await service.install("@demo/pi-tools", "2.0.1");

    expect(manager.installAndPersist).toHaveBeenCalledWith("npm:@demo/pi-tools@2.0.1");
    expect(installed).toEqual([expect.objectContaining({
      name: "@demo/pi-tools",
      version: "2.0.1",
      installed: true,
      verification: "verified",
      provenance: "npm-registry",
    })]);
  });

  it("extracts publisher usage guidance from the package README", async () => {
    const service = new PluginService("/agent", "/cwd", () => {}, {
      fetch: (async () => response({
        name: "pi-browser",
        version: "1.0.0",
        description: "Control a browser from Pi",
        keywords: ["pi-package"],
        pi: { extensions: ["./extension.ts"] },
        readme: "# Pi Browser\n\n## Quick start\n\nInstall the plugin, then ask Pi to open a page.\n\n```text\nOpen example.com\n```\n\n## API\n\nInternal details.",
      })) as typeof fetch,
      packageManager: fakePackageManager(),
    });

    const details = await service.details("pi-browser", "1.0.0");

    expect(details.usage).toContain("ask Pi to open a page");
    expect(details.usage).not.toContain("Internal details");
  });

  it("rejects untagged npm packages before installation", async () => {
    const manager = fakePackageManager();
    const service = new PluginService("/agent", "/cwd", () => {}, {
      fetch: (async () => response({ name: "unsafe", version: "1.0.0", keywords: [] })) as typeof fetch,
      packageManager: manager,
    });

    await expect(service.install("unsafe", "1.0.0")).rejects.toThrow("pi-package");
    expect(manager.installAndPersist).not.toHaveBeenCalled();
  });

  it("rejects manifest path traversal and exact-version mismatches", async () => {
    const manager = fakePackageManager();
    const securityStore = new PluginSecurityStore(tempDirectory("plugin-security"));
    const traversal = new PluginService("/agent", "/cwd", () => {}, {
      fetch: (async () => response({ name: "pi-unsafe", version: "1.0.0", keywords: ["pi-package"], pi: { extensions: ["../escape.ts"] } })) as typeof fetch,
      packageManager: manager,
      securityStore,
    });
    await expect(traversal.install("pi-unsafe", "1.0.0")).rejects.toThrow("路径越界");

    const mismatch = new PluginService("/agent", "/cwd", () => {}, {
      fetch: (async () => response({ name: "pi-safe", version: "2.0.0", keywords: ["pi-package"], pi: { themes: ["./themes"] } })) as typeof fetch,
      packageManager: manager,
      securityStore,
    });
    await expect(mismatch.install("pi-safe", "1.0.0")).rejects.toThrow("不匹配的版本");
    expect(manager.installAndPersist).not.toHaveBeenCalled();
  });

  it("persists registry integrity and supports user and project enablement", async () => {
    const cwd = tempDirectory("project");
    const manager = fakePackageManager({ themes: ["./themes"] });
    const securityStore = new PluginSecurityStore(tempDirectory("plugin-security"));
    const service = new PluginService("/agent", cwd, () => {}, {
      fetch: (async () => response({
        name: "pi-theme",
        version: "1.4.0",
        keywords: ["pi-package"],
        publisher: { username: "verified-publisher" },
        pi: { themes: ["./themes"] },
        dist: { integrity: "sha512-demo", shasum: "abc123" },
      })) as typeof fetch,
      packageManager: manager,
      securityStore,
    });

    await service.install("pi-theme", "1.4.0");
    expect(service.listInstalled(cwd)).toEqual([expect.objectContaining({
      enabled: true,
      projectEnabled: true,
      integrity: "sha512-demo",
      riskTier: "low",
    })]);
    service.setEnabled("npm:pi-theme@1.4.0", false, cwd, "project");
    expect(securityStore.isEnabled("npm:pi-theme@1.4.0", cwd)).toBe(false);
    expect(securityStore.isEnabled("npm:pi-theme@1.4.0")).toBe(true);
    service.setEnabled("npm:pi-theme@1.4.0", false);
    expect(securityStore.isEnabled("npm:pi-theme@1.4.0")).toBe(false);
  });

  it("normalizes diverse registry metadata and assigns conservative risk tiers", async () => {
    const fetchMock = vi.fn(async () => response({
      total: "unknown",
      objects: [
        {
          package: {
            name: "pi-legacy",
            version: "1.0.0",
            description: "  Legacy plugin  ",
            keywords: "utility, pi-package",
            author: "Legacy Author",
            repository: "git+https://github.com/demo/pi-legacy.git",
            readme: "# Package\n\nNo usage section.",
          },
        },
        {
          package: {
            name: "pi-theme",
            version: "2.0.0",
            keywords: ["pi-package", 3],
            publisher: { name: "Theme Publisher" },
            pi: { themes: ["./themes"] },
            dist: { shasum: "abc" },
            links: { homepage: "https://example.com/theme" },
            downloads: { weekly: 44, monthly: 200 },
          },
          downloads: { weekly: Number.NaN, monthly: 250 },
        },
        {
          package: {
            name: "pi-skill",
            version: "3.0.0",
            keywords: ["PI-PACKAGE"],
            author: { name: "Skill Author" },
            pi: { skills: ["./skills"], prompts: ["!./optional-prompt.md"] },
            dist: { integrity: "sha512-skill" },
            repository: { url: "https://github.com/demo/pi-skill.git" },
          },
          score: { final: 0.8 },
        },
        {
          package: {
            name: "pi-blocked",
            version: "1.0.0",
            keywords: ["pi-package"],
            insecure: true,
            pi: {},
            dist: { integrity: "sha512-blocked" },
          },
        },
        { package: { version: "1.0.0", keywords: ["pi-package"] } },
        {},
      ],
    }));
    const service = new PluginService("/agent", "/cwd", () => {}, {
      fetch: fetchMock as typeof fetch,
      registryUrl: "https://registry.example/",
      packageManager: fakePackageManager(),
    });

    const result = await service.search("   ", -20);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/registry\.example\/-\/v1\/search\?/));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("from=0"));
    expect(result).toMatchObject({ total: 4, offset: 0 });
    expect(result.packages).toEqual([
      expect.objectContaining({
        name: "pi-legacy",
        description: "Legacy plugin",
        publisher: "Legacy Author",
        repositoryUrl: "https://github.com/demo/pi-legacy",
        usage: undefined,
        riskTier: "high",
        compatibility: "unknown",
      }),
      expect.objectContaining({
        name: "pi-theme",
        publisher: "Theme Publisher",
        weeklyDownloads: 44,
        monthlyDownloads: 250,
        riskTier: "low",
        compatibility: "desktop",
      }),
      expect.objectContaining({
        name: "pi-skill",
        publisher: "Skill Author",
        score: 0.8,
        riskTier: "medium",
        repositoryUrl: "https://github.com/demo/pi-skill",
      }),
      expect.objectContaining({ name: "pi-blocked", insecure: true, riskTier: "blocked" }),
    ]);
  });

  it("rejects unsafe registry responses and rolls back unverifiable installs", async () => {
    const manager = fakePackageManager({ extensions: ["./extension.ts"] });
    const securityStore = new PluginSecurityStore(tempDirectory("plugin-rollback-security"));
    const responses = [
      response({}, 404),
      response({}, 503),
      response({ version: "1.0.0", keywords: ["pi-package"] }),
      response({ name: "different-name", version: "1.0.0", keywords: ["pi-package"] }),
      response({ name: "pi-mismatch", version: "2.0.0", keywords: ["pi-package"] }),
      response({ name: "pi-blocked", version: "1.0.0", keywords: ["pi-package"], insecure: true }),
      response({ name: "pi-tampered", version: "1.0.0", keywords: ["pi-package"], pi: { themes: ["./themes"] }, dist: { integrity: "sha512-ok" } }),
    ];
    const service = new PluginService("/agent", "/cwd", () => {}, {
      fetch: (async () => responses.shift()!) as typeof fetch,
      packageManager: manager,
      securityStore,
    });

    await expect(service.details("bad/name", "latest")).rejects.toThrow("包名无效");
    await expect(service.details("pi-safe", "bad version")) .rejects.toThrow("版本无效");
    await expect(service.details("pi-missing")).rejects.toThrow("没有找到");
    await expect(service.details("pi-error")).rejects.toThrow("HTTP 503");
    await expect(service.details("pi-incomplete")).rejects.toThrow("元数据不完整");
    await expect(service.details("pi-expected", "1.0.0")).rejects.toThrow("不匹配的包名");
    await expect(service.details("pi-mismatch", "1.0.0")).rejects.toThrow("不匹配的版本");
    await expect(service.install("pi-blocked", "1.0.0")).rejects.toThrow("安全风险");
    await expect(service.install("pi-tampered", "1.0.0")).rejects.toThrow("校验失败");
    expect(manager.removeAndPersist).toHaveBeenCalledWith("npm:pi-tampered@1.0.0");
    expect(securityStore.list()).toEqual([]);
  });

  it("removes installed plugins and validates enablement scope", async () => {
    const manager = fakePackageManager({ themes: ["./themes"] });
    const securityStore = new PluginSecurityStore(tempDirectory("plugin-remove-security"));
    const service = new PluginService("/agent", "/cwd", () => {}, {
      fetch: (async () => response({
        name: "pi-removable",
        version: "1.0.0",
        keywords: ["pi-package"],
        pi: { themes: ["./themes"] },
        dist: { integrity: "sha512-remove" },
      })) as typeof fetch,
      packageManager: manager,
      securityStore,
    });

    await expect(service.remove("file:plugin")).rejects.toThrow("只能移除");
    await expect(service.remove("npm:missing@1.0.0")).rejects.toThrow("未安装");
    expect(() => service.setEnabled("npm:missing@1.0.0", false)).toThrow("未安装");
    await service.install("pi-removable", "1.0.0");
    expect(() => service.setEnabled("npm:pi-removable@1.0.0", false, undefined, "project")).toThrow("需要工作区路径");
    await expect(service.remove("npm:pi-removable@1.0.0")).resolves.toEqual([]);
    expect(securityStore.get("npm:pi-removable@1.0.0")).toBeUndefined();
    service.dispose();
    expect(manager.progress).toBeUndefined();
  });

  it("reports legacy unpinned plugin records with missing install directories", () => {
    let progress: ProgressCallback | undefined;
    const manager: PackageManagerPort = {
      setProgressCallback(callback) { progress = callback; },
      listConfiguredPackages: () => [
        { source: "npm:legacy-plugin", scope: "user", filtered: false },
        { source: "npm:project-only@1.0.0", scope: "project", filtered: false },
        { source: "git:https://example.com/plugin", scope: "user", filtered: false },
      ],
      getInstalledPath: () => undefined,
      installAndPersist: vi.fn(),
      removeAndPersist: vi.fn(),
    };
    const service = new PluginService("/agent", "/cwd", () => {}, {
      packageManager: manager,
      securityStore: new PluginSecurityStore(tempDirectory("legacy-missing-security")),
    });

    expect(progress).toEqual(expect.any(Function));
    expect(service.listInstalled("/cwd")).toEqual([expect.objectContaining({
      source: "npm:legacy-plugin",
      name: "legacy-plugin",
      version: undefined,
      installed: false,
      enabled: true,
      projectEnabled: true,
      provenance: "legacy",
      riskTier: "high",
      resources: [],
      verification: "missing",
    })]);
  });
});
