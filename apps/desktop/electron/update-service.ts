import type { UpdateSnapshotManifest, UpdateSnapshotStore } from "./update-snapshot-store.js";
import type { UpdateState } from "../src/contracts.js";

export interface AppUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (value?: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export type UpdateServiceOptions = {
  updater: AppUpdaterPort;
  snapshots: Pick<UpdateSnapshotStore, "create">;
  currentVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  hasActiveWork(): boolean | Promise<boolean>;
  flush(): void | Promise<void>;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function version(value: unknown): string | undefined {
  const candidate = object(value)?.version;
  return typeof candidate === "string" && candidate.length <= 128 ? candidate : undefined;
}

function message(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 2_000);
  return String(value ?? "更新失败").slice(0, 2_000);
}

export class UpdateService {
  private stateValue: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private installing = false;
  private readonly supported: boolean;

  constructor(private readonly options: UpdateServiceOptions) {
    this.supported = options.isPackaged && (options.platform === "darwin" || options.platform === "win32");
    this.stateValue = { status: this.supported ? "idle" : "unsupported", currentVersion: options.currentVersion };
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    options.updater.allowDowngrade = false;
    options.updater.allowPrerelease = false;
    this.bindUpdaterEvents();
  }

  state(): UpdateState {
    return { ...this.stateValue };
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(): Promise<UpdateState> {
    this.assertSupported();
    this.setState({ status: "checking" });
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      this.setState({ status: "error", message: message(error) });
      throw error;
    }
    return this.state();
  }

  async download(): Promise<UpdateState> {
    this.assertSupported();
    if (this.stateValue.status !== "available") throw new Error("没有可下载的已验证更新。");
    this.setState({ status: "downloading", percent: 0 });
    try {
      await this.options.updater.downloadUpdate();
    } catch (error) {
      this.setState({ status: "error", message: message(error) });
      throw error;
    }
    return this.state();
  }

  async install(): Promise<UpdateState> {
    this.assertSupported();
    if (this.installing) throw new Error("更新安装已经开始。");
    if (this.stateValue.status !== "downloaded") throw new Error("更新尚未下载完成。");
    if (await this.options.hasActiveWork()) throw new Error("仍有 Agent 或后台 Subagent 任务，不能安装更新。");
    this.installing = true;
    try {
      await this.options.flush();
      const snapshot: UpdateSnapshotManifest = this.options.snapshots.create(this.options.currentVersion);
      this.setState({ ...this.stateValue, snapshotId: snapshot.id });
      this.options.updater.quitAndInstall(false, true);
      return this.state();
    } catch (error) {
      this.installing = false;
      this.setState({ status: "error", message: message(error) });
      throw error;
    }
  }

  private assertSupported(): void {
    if (!this.supported) throw new Error("自动更新只在已签名的 macOS/Windows 安装包中启用。");
  }

  private bindUpdaterEvents(): void {
    this.options.updater.on("checking-for-update", () => this.setState({ status: "checking" }));
    this.options.updater.on("update-available", (info) => this.setState({ status: "available", availableVersion: version(info) }));
    this.options.updater.on("update-not-available", () => this.setState({ status: "not-available" }));
    this.options.updater.on("download-progress", (progress) => {
      const percent = object(progress)?.percent;
      this.setState({ status: "downloading", percent: typeof percent === "number" && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined });
    });
    this.options.updater.on("update-downloaded", (info) => this.setState({ status: "downloaded", availableVersion: version(info) ?? this.stateValue.availableVersion, percent: 100 }));
    this.options.updater.on("error", (error) => this.setState({ status: "error", message: message(error) }));
  }

  private setState(patch: Omit<UpdateState, "currentVersion"> | UpdateState): void {
    this.stateValue = { currentVersion: this.options.currentVersion, ...patch };
    for (const listener of this.listeners) listener(this.state());
  }
}
