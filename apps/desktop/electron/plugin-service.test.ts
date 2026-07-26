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
});
