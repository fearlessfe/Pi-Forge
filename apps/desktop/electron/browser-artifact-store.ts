import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserScreenshotMetadata } from "../src/contracts.js";

const manifestName = "annotations.json";
const artifactPattern = /^pi-browser-annotation-([0-9a-f-]+)\.png$/i;

export const browserScreenshotTtlMs = 24 * 60 * 60 * 1_000;
export const browserScreenshotMaxCount = 32;
export const browserScreenshotMaxBytes = 256 * 1024 * 1024;

type ArtifactEntry = BrowserScreenshotMetadata & { fileName: string };

type ArtifactManifest = {
  version: 1;
  artifacts: ArtifactEntry[];
};

export type BrowserArtifactCleanupReport = {
  removedExpired: number;
  removedOrphaned: number;
  removedForCapacity: number;
  retained: number;
  retainedBytes: number;
};

export type BrowserArtifactStoreOptions = {
  now?: () => number;
  id?: () => string;
  ttlMs?: number;
  maxCount?: number;
  maxBytes?: number;
};

function isArtifactEntry(value: unknown): value is ArtifactEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<ArtifactEntry>;
  return typeof entry.id === "string"
    && typeof entry.owner === "string"
    && typeof entry.path === "string"
    && typeof entry.fileName === "string"
    && artifactPattern.test(entry.fileName)
    && entry.fileName === `pi-browser-annotation-${entry.id}.png`
    && path.basename(entry.path) === entry.fileName
    && typeof entry.createdAt === "string"
    && Number.isFinite(Date.parse(entry.createdAt))
    && typeof entry.expiresAt === "string"
    && Number.isFinite(Date.parse(entry.expiresAt))
    && typeof entry.ttlMs === "number"
    && Number.isSafeInteger(entry.ttlMs)
    && entry.ttlMs > 0
    && typeof entry.byteSize === "number"
    && Number.isSafeInteger(entry.byteSize)
    && entry.byteSize >= 0;
}

export class BrowserArtifactStore {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly ttlMs: number;
  private readonly maxCount: number;
  private readonly maxBytes: number;
  private operation = Promise.resolve<unknown>(undefined);

  constructor(
    private readonly directory: string,
    options: BrowserArtifactStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.ttlMs = options.ttlMs ?? browserScreenshotTtlMs;
    this.maxCount = options.maxCount ?? browserScreenshotMaxCount;
    this.maxBytes = options.maxBytes ?? browserScreenshotMaxBytes;
    if (this.ttlMs <= 0 || this.maxCount <= 0 || this.maxBytes <= 0) {
      throw new Error("浏览器截图生命周期配置无效。");
    }
  }

  save(bytes: Uint8Array, owner: string): Promise<BrowserScreenshotMetadata> {
    return this.serial(async () => {
      const normalizedOwner = owner.trim().slice(0, 256);
      if (!normalizedOwner) throw new Error("浏览器截图 owner 无效。");
      if (bytes.byteLength > this.maxBytes) throw new Error("浏览器截图超过容量上限。");
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const id = this.id();
      const fileName = `pi-browser-annotation-${id}.png`;
      const artifactPath = path.join(this.directory, fileName);
      const createdAtMs = this.now();
      const metadata: BrowserScreenshotMetadata = {
        id,
        owner: normalizedOwner,
        path: artifactPath,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
        ttlMs: this.ttlMs,
        byteSize: bytes.byteLength,
      };
      await fs.writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
      try {
        const manifest = await this.readManifest();
        manifest.artifacts.push({ ...metadata, fileName });
        await this.reconcile(manifest, createdAtMs);
        await this.writeManifest(manifest);
      } catch (error) {
        await fs.unlink(artifactPath).catch(() => undefined);
        throw error;
      }
      return metadata;
    });
  }

  cleanup(): Promise<BrowserArtifactCleanupReport> {
    return this.serial(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const manifest = await this.readManifest();
      const report = await this.reconcile(manifest, this.now());
      await this.writeManifest(manifest);
      return report;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operation.then(work, work);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private async readManifest(): Promise<ArtifactManifest> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.directory, manifestName), "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { version: 1, artifacts: [] };
      const input = raw as Partial<ArtifactManifest>;
      if (input.version !== 1 || !Array.isArray(input.artifacts)) return { version: 1, artifacts: [] };
      return { version: 1, artifacts: input.artifacts.filter(isArtifactEntry) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return { version: 1, artifacts: [] };
      }
      throw error;
    }
  }

  private async reconcile(manifest: ArtifactManifest, now: number): Promise<BrowserArtifactCleanupReport> {
    const files = await fs.readdir(this.directory);
    const artifactFiles = new Set(files.filter((fileName) => artifactPattern.test(fileName)));
    let removedExpired = 0;
    let removedOrphaned = 0;
    let removedForCapacity = 0;
    const retained: Array<{ entry: ArtifactEntry; order: number }> = [];

    for (const [order, entry] of manifest.artifacts.entries()) {
      if (!artifactFiles.delete(entry.fileName)) continue;
      const actualPath = path.join(this.directory, entry.fileName);
      const stat = await fs.stat(actualPath).catch(() => undefined);
      if (!stat?.isFile()) continue;
      if (Date.parse(entry.expiresAt) <= now) {
        await fs.unlink(actualPath).catch(() => undefined);
        removedExpired += 1;
        continue;
      }
      retained.push({ entry: { ...entry, path: actualPath, byteSize: stat.size }, order });
    }

    for (const fileName of artifactFiles) {
      await fs.unlink(path.join(this.directory, fileName)).catch(() => undefined);
      removedOrphaned += 1;
    }

    retained.sort((left, right) => Date.parse(right.entry.createdAt) - Date.parse(left.entry.createdAt) || right.order - left.order);
    let retainedBytes = retained.reduce((total, item) => total + item.entry.byteSize, 0);
    while (retained.length > this.maxCount || retainedBytes > this.maxBytes) {
      const item = retained.pop();
      if (!item) break;
      const { entry } = item;
      await fs.unlink(path.join(this.directory, entry.fileName)).catch(() => undefined);
      retainedBytes -= entry.byteSize;
      removedForCapacity += 1;
    }
    manifest.artifacts = retained.map((item) => item.entry);
    return {
      removedExpired,
      removedOrphaned,
      removedForCapacity,
      retained: retained.length,
      retainedBytes,
    };
  }

  private async writeManifest(manifest: ArtifactManifest): Promise<void> {
    const manifestPath = path.join(this.directory, manifestName);
    const temporaryPath = path.join(this.directory, `${manifestName}.tmp`);
    await fs.writeFile(temporaryPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, manifestPath);
  }
}
