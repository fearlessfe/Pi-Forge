import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, TaskFileChange } from "../src/contracts.js";
import { isInsideWorkspace } from "./permission-policy.js";
import { errorMessage } from "./error-message.js";

type EventSink = (event: AgentEvent) => void;

type PendingFileMutation = {
  cwd: string;
  path: string;
  existed: boolean;
  before?: Buffer;
  beforeHash?: string;
};

const maxDiffSnapshotBytes = 5 * 1024 * 1024;
export const fileChangesEntryType = "pi-desktop:file-changes";

export function parseStoredFileChange(value: unknown): TaskFileChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const change = value as Record<string, unknown>;
  if (
    typeof change.id !== "string"
    || typeof change.runId !== "string"
    || typeof change.callId !== "string"
    || typeof change.path !== "string"
    || typeof change.relativePath !== "string"
    || (change.kind !== "created" && change.kind !== "modified")
    || typeof change.patch !== "string"
    || typeof change.afterHash !== "string"
    || (change.status !== "pending" && change.status !== "accepted" && change.status !== "reverted" && change.status !== "conflict")
  ) return undefined;
  return {
    id: change.id,
    runId: change.runId,
    callId: change.callId,
    path: change.path,
    relativePath: change.relativePath,
    kind: change.kind,
    patch: change.patch,
    beforeHash: typeof change.beforeHash === "string" ? change.beforeHash : undefined,
    afterHash: change.afterHash,
    status: change.status,
    // Modified files need an in-memory before snapshot, which is intentionally not persisted.
    revertible: change.kind === "created" && change.revertible === true,
    error: typeof change.error === "string" ? change.error : undefined,
  };
}

export class FileChangeTracker {
  private sessionCwd?: string;
  private readonly pendingFileMutations = new Map<string, PendingFileMutation>();
  private readonly fileChanges = new Map<string, TaskFileChange>();
  private readonly changeSnapshots = new Map<string, Buffer | undefined>();
  private lastChangeRunId?: string;

  constructor(
    private readonly emit: EventSink,
    private readonly persist: (runId: string) => void,
  ) {}

  setSessionCwd(cwd: string | undefined): void {
    this.sessionCwd = cwd;
  }

  clearPendingMutations(): void {
    this.pendingFileMutations.clear();
  }

  setLastChangeRunId(runId: string): void {
    this.lastChangeRunId = runId;
  }

  restoreChange(change: TaskFileChange): void {
    this.fileChanges.set(change.id, change);
  }

  listChanges(runId = this.lastChangeRunId): TaskFileChange[] {
    if (!runId) return [];
    return [...this.fileChanges.values()].filter((change) => change.runId === runId).map((change) => ({ ...change }));
  }

  changePath(changeId: string): string {
    const change = this.fileChanges.get(changeId);
    if (!change) throw new Error("找不到该文件变更，请重新打开会话后再试。");
    if (!path.isAbsolute(change.path) || !fs.existsSync(change.path) || !fs.statSync(change.path).isFile()) {
      throw new Error("成果物不存在或已被移动。");
    }
    return change.path;
  }

  acceptChanges(changeIds?: string[]): TaskFileChange[] {
    const selected = this.selectedChanges(changeIds);
    const runs = new Set<string>();
    for (const change of selected) {
      if (change.status !== "pending" && change.status !== "conflict") continue;
      change.status = "accepted";
      change.error = undefined;
      this.changeSnapshots.delete(change.id);
      runs.add(change.runId);
    }
    this.emitChangedRuns(runs);
    return this.listChanges(selected[0]?.runId);
  }

  revertChanges(changeIds?: string[]): TaskFileChange[] {
    const selected = this.selectedChanges(changeIds).reverse();
    const runs = new Set<string>();
    for (const change of selected) {
      if (change.status !== "pending") continue;
      runs.add(change.runId);
      if (!change.revertible) {
        change.status = "conflict";
        change.error = "该文件超过安全快照上限，无法自动回退。";
        continue;
      }
      try {
        const currentHash = fs.existsSync(change.path) && fs.statSync(change.path).isFile() ? this.hashFile(change.path) : undefined;
        if (currentHash !== change.afterHash) {
          change.status = "conflict";
          change.error = "文件在 Agent 修改后又发生了变化，已停止回退以避免覆盖新内容。";
          continue;
        }
        if (change.kind === "created") {
          fs.unlinkSync(change.path);
        } else {
          const before = this.changeSnapshots.get(change.id);
          if (!before) throw new Error("回退快照不可用。");
          fs.writeFileSync(change.path, before);
        }
        change.status = "reverted";
        change.error = undefined;
        this.changeSnapshots.delete(change.id);
      } catch (error) {
        change.status = "conflict";
        change.error = errorMessage(error);
      }
    }
    this.emitChangedRuns(runs);
    return this.listChanges(selected[0]?.runId);
  }

  captureFileMutationStart(callId: string, toolName: string, args: unknown): void {
    if ((toolName !== "edit" && toolName !== "write") || !this.sessionCwd || !args || typeof args !== "object") return;
    const candidate = (args as Record<string, unknown>).path;
    if (typeof candidate !== "string" || !candidate || !isInsideWorkspace(this.sessionCwd, candidate)) return;
    const absolutePath = path.resolve(this.sessionCwd, candidate);
    const existed = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
    let before: Buffer | undefined;
    let beforeHash: string | undefined;
    if (existed) {
      const size = fs.statSync(absolutePath).size;
      if (size <= maxDiffSnapshotBytes) before = fs.readFileSync(absolutePath);
      beforeHash = before ? this.hashBuffer(before) : this.hashFile(absolutePath);
    }
    this.pendingFileMutations.set(callId, { cwd: this.sessionCwd, path: absolutePath, existed, before, beforeHash });
  }

  captureFileMutationEnd(runId: string, callId: string, toolName: string, result: unknown, isError: boolean): void {
    const pending = this.pendingFileMutations.get(callId);
    this.pendingFileMutations.delete(callId);
    if (!pending || isError || (toolName !== "edit" && toolName !== "write") || !fs.existsSync(pending.path) || !fs.statSync(pending.path).isFile()) return;
    const size = fs.statSync(pending.path).size;
    const after = size <= maxDiffSnapshotBytes ? fs.readFileSync(pending.path) : undefined;
    const afterHash = after ? this.hashBuffer(after) : this.hashFile(pending.path);
    if (pending.beforeHash === afterHash) return;
    const relativePath = path.relative(pending.cwd, pending.path) || path.basename(pending.path);
    const existing = [...this.fileChanges.values()].find((change) => (
      change.runId === runId
      && change.path === pending.path
      && change.status === "pending"
    ));
    if (existing) {
      if (existing.beforeHash === afterHash) {
        this.fileChanges.delete(existing.id);
        this.changeSnapshots.delete(existing.id);
        this.emit({ type: "changes.updated", runId, changes: this.listChanges(runId) });
        return;
      }
      const originalBefore = this.changeSnapshots.get(existing.id);
      existing.patch = this.buildPatch(relativePath, originalBefore, existing.kind === "modified", after, result);
      existing.afterHash = afterHash;
      existing.error = undefined;
      this.lastChangeRunId = runId;
      this.emit({ type: "changes.updated", runId, changes: this.listChanges(runId) });
      return;
    }
    const patch = this.buildPatch(relativePath, pending.before, pending.existed, after, result);
    const change: TaskFileChange = {
      id: randomUUID(),
      runId,
      callId,
      path: pending.path,
      relativePath,
      kind: pending.existed ? "modified" : "created",
      patch,
      beforeHash: pending.beforeHash,
      afterHash,
      status: "pending",
      revertible: !pending.existed || Boolean(pending.before),
    };
    this.fileChanges.set(change.id, change);
    this.changeSnapshots.set(change.id, pending.before);
    this.lastChangeRunId = runId;
    this.emit({ type: "changes.updated", runId, changes: this.listChanges(runId) });
  }

  private buildPatch(relativePath: string, before: Buffer | undefined, existed: boolean, after: Buffer | undefined, result: unknown): string {
    if (after && (!existed || before) && !after.includes(0) && !before?.includes(0)) {
      return generateUnifiedPatch(relativePath, before?.toString("utf8") ?? "", after.toString("utf8"));
    }
    if (result && typeof result === "object") {
      const details = (result as { details?: { patch?: unknown } }).details;
      if (typeof details?.patch === "string" && details.patch) return details.patch;
    }
    return `Binary or large file changed: ${relativePath}`;
  }

  private selectedChanges(changeIds?: string[]): TaskFileChange[] {
    const ids = changeIds ? new Set(changeIds) : undefined;
    return [...this.fileChanges.values()].filter((change) => !ids || ids.has(change.id));
  }

  private emitChangedRuns(runIds: ReadonlySet<string>): void {
    for (const runId of runIds) {
      this.persist(runId);
      this.emit({ type: "changes.updated", runId, changes: this.listChanges(runId) });
    }
  }

  private hashBuffer(value: Buffer): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private hashFile(filePath: string): string {
    const hash = createHash("sha256");
    const descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      do {
        bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead);
      return hash.digest("hex");
    } finally {
      fs.closeSync(descriptor);
    }
  }
}
