import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type UpdateSnapshotRoot = { name: string; path: string };

export type UpdateSnapshotFile = {
  root: string;
  path: string;
  size: number;
  sha256: string;
};

export type UpdateSnapshotManifest = {
  schemaVersion: 1;
  id: string;
  appVersion: string;
  createdAt: string;
  files: UpdateSnapshotFile[];
};

const excludedNames = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache",
  "blob_storage", "Crashpad", "logs", "update-snapshots",
]);

function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function safeName(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error(`Invalid snapshot root name: ${value}`);
  return value;
}

function safeRelativePath(value: string): boolean {
  const segments = value.split(/[\\/]/);
  return value.length > 0
    && !value.includes("\0")
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function filesBelow(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (excludedNames.has(entry.name) || entry.isSymbolicLink()) return [];
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return filesBelow(root, child);
    return entry.isFile() ? [child] : [];
  });
}

export class UpdateSnapshotStore {
  private readonly rootNames: Set<string>;

  constructor(
    readonly directory: string,
    private readonly roots: UpdateSnapshotRoot[],
    private readonly retention = 2,
  ) {
    const names = new Set<string>();
    for (const root of roots) {
      safeName(root.name);
      if (names.has(root.name)) throw new Error(`Duplicate snapshot root name: ${root.name}`);
      names.add(root.name);
    }
    this.rootNames = names;
  }

  list(): UpdateSnapshotManifest[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".tmp"))
      .flatMap((entry) => {
        try {
          const value = JSON.parse(fs.readFileSync(path.join(this.directory, entry.name, "manifest.json"), "utf8")) as UpdateSnapshotManifest;
          return this.validateManifest(value, entry.name) ? [value] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  create(appVersion: string): UpdateSnapshotManifest {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(appVersion)) throw new Error("Invalid application version for update snapshot.");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const latestCreatedAt = this.list().reduce(
      (latest, snapshot) => Math.max(latest, Date.parse(snapshot.createdAt) || 0),
      0,
    );
    const createdAtMs = Math.max(Date.now(), latestCreatedAt + 1);
    const id = `${createdAtMs}-${randomUUID()}`;
    const temporary = path.join(this.directory, `${id}.tmp`);
    const destination = path.join(this.directory, id);
    const files: UpdateSnapshotFile[] = [];
    try {
      fs.mkdirSync(temporary, { mode: 0o700 });
      for (const root of this.roots) {
        for (const relative of filesBelow(root.path)) {
          const source = path.join(root.path, relative);
          const target = path.join(temporary, "roots", root.name, relative);
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.copyFileSync(source, target);
          const stat = fs.statSync(target);
          files.push({ root: root.name, path: relative, size: stat.size, sha256: hashFile(target) });
        }
      }
      const manifest: UpdateSnapshotManifest = {
        schemaVersion: 1,
        id,
        appVersion,
        createdAt: new Date(createdAtMs).toISOString(),
        files: files.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`)),
      };
      fs.writeFileSync(path.join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      this.verifyDirectory(temporary, manifest);
      fs.renameSync(temporary, destination);
      this.prune();
      return manifest;
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  restoreTo(id: string, targets: Record<string, string>): UpdateSnapshotManifest {
    const snapshot = path.join(this.directory, path.basename(id));
    if (path.basename(id) !== id) throw new Error("Invalid update snapshot id.");
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, "manifest.json"), "utf8")) as UpdateSnapshotManifest;
    if (!this.validateManifest(manifest, id)) throw new Error("Invalid update snapshot manifest.");
    this.verifyDirectory(snapshot, manifest);
    for (const root of this.roots) {
      const target = targets[root.name];
      if (!target) throw new Error(`Missing restore target for ${root.name}.`);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const file of manifest.files.filter((entry) => entry.root === root.name)) {
        const source = path.join(snapshot, "roots", root.name, file.path);
        const destination = path.join(target, file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, destination);
      }
    }
    return manifest;
  }

  private verifyDirectory(directory: string, manifest: UpdateSnapshotManifest): void {
    for (const file of manifest.files) {
      const candidate = path.join(directory, "roots", safeName(file.root), file.path);
      const relative = path.relative(path.join(directory, "roots", file.root), candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Snapshot file escapes its root.");
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size !== file.size || hashFile(candidate) !== file.sha256) {
        throw new Error(`Update snapshot integrity check failed: ${file.root}/${file.path}`);
      }
    }
  }

  private validateManifest(value: UpdateSnapshotManifest, id: string): boolean {
    return value?.schemaVersion === 1
      && value.id === id
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.appVersion)
      && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
      && Array.isArray(value.files)
      && value.files.every((file) => file && typeof file.root === "string" && typeof file.path === "string"
        && this.rootNames.has(file.root) && safeRelativePath(file.path)
        && Number.isInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256));
  }

  private prune(): void {
    for (const snapshot of this.list().slice(Math.max(1, this.retention))) {
      fs.rmSync(path.join(this.directory, snapshot.id), { recursive: true, force: true });
    }
  }
}
