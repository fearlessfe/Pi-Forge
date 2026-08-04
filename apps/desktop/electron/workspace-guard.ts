import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResourceStore } from "./resource-store.js";

/**
 * Rejects renderer-supplied working directories that were never opened by the
 * user (or migrated from existing sessions). The cwd becomes the agent's
 * workspace root and inherits in-workspace auto-approval, so it must not be
 * freely chosen by the renderer.
 */
export function requireKnownWorkspace(store: ResourceStore, cwd: string): void {
  if (!store.isKnownWorkspace(cwd)) {
    throw new Error("该目录不是已打开的工作区，请先通过应用打开该目录。");
  }
}

function isInsideWorkspace(workspace: string, target: string): boolean {
  const relative = path.relative(workspace, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolves a renderer-supplied Markdown file reference only after re-checking
 * that its workspace is known. Both the workspace and target are canonicalized
 * so symlinks cannot escape the selected workspace.
 */
export function resolveWorkspaceFileReference(store: ResourceStore, cwd: string, reference: string): string {
  requireKnownWorkspace(store, cwd);
  if (!reference || reference !== reference.trim() || /[\0\r\n]/.test(reference)) {
    throw new Error("工作区文件引用无效。");
  }

  let workspace: string;
  try {
    workspace = fs.realpathSync(path.resolve(cwd));
  } catch {
    throw new Error("工作区已不存在或无法访问。");
  }
  try {
    if (!fs.statSync(workspace).isDirectory()) throw new Error("工作区路径不是目录。");
  } catch (error) {
    if (error instanceof Error && error.message === "工作区路径不是目录。") throw error;
    throw new Error("工作区已不存在或无法访问。");
  }

  let candidate: string;
  try {
    if (/^[\\/]{2}/.test(reference)) {
      throw new Error("工作区文件引用只允许本地文件路径。");
    }
    if (path.isAbsolute(reference)) {
      if (reference.includes("?")) throw new Error("工作区文件引用只允许本地文件路径。");
      const fragment = reference.indexOf("#");
      candidate = decodeURIComponent(fragment === -1 ? reference : reference.slice(0, fragment));
    } else {
      const parsed = new URL(reference, pathToFileURL(`${workspace}${path.sep}`));
      if (parsed.protocol !== "file:" || (parsed.hostname && parsed.hostname !== "localhost") || parsed.search) {
        throw new Error("工作区文件引用只允许本地文件路径。");
      }
      candidate = fileURLToPath(parsed);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "工作区文件引用只允许本地文件路径。") throw error;
    throw new Error("工作区文件引用无效。");
  }

  let target: string;
  try {
    target = fs.realpathSync(path.resolve(candidate));
  } catch {
    const withoutLocation = candidate.replace(/:\d+(?::\d+)?$/, "");
    if (withoutLocation === candidate) throw new Error("工作区文件不存在或无法访问。");
    try {
      target = fs.realpathSync(path.resolve(withoutLocation));
    } catch {
      throw new Error("工作区文件不存在或无法访问。");
    }
  }
  if (!isInsideWorkspace(workspace, target)) throw new Error("拒绝打开工作区之外的文件。");
  try {
    if (!fs.statSync(target).isFile()) throw new Error("工作区引用不是文件。");
  } catch (error) {
    if (error instanceof Error && error.message === "工作区引用不是文件。") throw error;
    throw new Error("工作区文件不存在或无法访问。");
  }
  return target;
}

function readFirstLine(filePath: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return undefined;
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = chunk.indexOf("\n");
    return newline === -1 ? chunk : chunk.slice(0, newline);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * Migration: registers the cwds of already persisted sessions so existing
 * conversations keep working after the known-workspace restriction lands.
 * Session files are JSONL with a `{"type":"session",...,"cwd":...}` header.
 * Never throws — unreadable directories or files are skipped.
 */
export function seedKnownWorkspacesFromSessions(store: ResourceStore, sessionDirs: string[]): number {
  let seeded = 0;
  for (const sessionDir of sessionDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(sessionDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const firstLine = readFirstLine(path.join(sessionDir, entry));
      if (!firstLine) continue;
      try {
        const header = JSON.parse(firstLine) as Record<string, unknown>;
        if (header.type === "session" && typeof header.cwd === "string" && path.isAbsolute(header.cwd)
          && !store.isKnownWorkspace(header.cwd)) {
          store.addKnownWorkspace(header.cwd);
          seeded += 1;
        }
      } catch {
        // Ignore malformed session headers.
      }
    }
  }
  return seeded;
}
