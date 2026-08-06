import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { UpdateService, type AppUpdaterPort } from "./update-service.js";

class FakeUpdater extends EventEmitter implements AppUpdaterPort {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

function service(overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const updater = new FakeUpdater();
  const snapshots = { create: vi.fn(() => ({
    schemaVersion: 1 as const,
    id: "snapshot-1",
    appVersion: "1.2.3",
    createdAt: "2026-08-06T00:00:00.000Z",
    files: [],
  })) };
  const flush = vi.fn(async () => undefined);
  const instance = new UpdateService({
    updater,
    snapshots,
    currentVersion: "1.2.3",
    platform: "darwin",
    isPackaged: true,
    hasActiveWork: () => false,
    flush,
    ...overrides,
  });
  return { instance, updater, snapshots, flush };
}

describe("UpdateService", () => {
  it("keeps feed selection Main-only and disables implicit download, install, and downgrade", async () => {
    const { instance, updater } = service();
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false });
    await instance.check();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    updater.emit("update-available", { version: "1.3.0" });
    expect(instance.state()).toMatchObject({ status: "available", availableVersion: "1.3.0" });
    await instance.download();
    updater.emit("download-progress", { percent: 42.5 });
    expect(instance.state()).toMatchObject({ status: "downloading", percent: 42.5 });
    updater.emit("update-downloaded", { version: "1.3.0" });
    expect(instance.state()).toMatchObject({ status: "downloaded", percent: 100 });
  });

  it("blocks install while work is active and snapshots state after flush before quitting", async () => {
    const active = service({ hasActiveWork: () => true });
    active.updater.emit("update-downloaded", { version: "1.3.0" });
    await expect(active.instance.install()).rejects.toThrow("仍有 Agent");
    expect(active.snapshots.create).not.toHaveBeenCalled();

    const idle = service();
    idle.updater.emit("update-downloaded", { version: "1.3.0" });
    await idle.instance.install();
    expect(idle.flush).toHaveBeenCalledOnce();
    expect(idle.snapshots.create).toHaveBeenCalledWith("1.2.3");
    expect(idle.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(idle.instance.state().snapshotId).toBe("snapshot-1");
  });

  it("fails closed outside signed packaged macOS/Windows builds", async () => {
    const { instance } = service({ isPackaged: false, platform: "linux" });
    expect(instance.state().status).toBe("unsupported");
    await expect(instance.check()).rejects.toThrow("已签名");
    await expect(instance.download()).rejects.toThrow("已签名");
    await expect(instance.install()).rejects.toThrow("已签名");
  });
});
