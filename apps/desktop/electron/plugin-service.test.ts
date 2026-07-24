import { describe, expect, it, vi } from "vitest";
import type { PackageManager, ProgressCallback } from "@earendil-works/pi-coding-agent";
import { PluginService } from "./plugin-service.js";

type PackageManagerPort = Pick<
  PackageManager,
  "installAndPersist" | "removeAndPersist" | "listConfiguredPackages" | "setProgressCallback" | "getInstalledPath"
>;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakePackageManager(): PackageManagerPort & { progress?: ProgressCallback } {
  const configured: Array<{ source: string; scope: "user"; filtered: boolean; installedPath?: string }> = [];
  return {
    progress: undefined,
    setProgressCallback(callback) { this.progress = callback; },
    listConfiguredPackages: () => configured,
    getInstalledPath: () => undefined,
    installAndPersist: vi.fn(async (source: string) => {
      configured.push({ source, scope: "user", filtered: false, installedPath: `/plugins/${source.slice(4)}` });
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
    });

    const installed = await service.install("@demo/pi-tools", "2.0.1");

    expect(manager.installAndPersist).toHaveBeenCalledWith("npm:@demo/pi-tools@2.0.1");
    expect(installed).toEqual([expect.objectContaining({
      name: "@demo/pi-tools",
      version: "2.0.1",
      installed: true,
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
});
