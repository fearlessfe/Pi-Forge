import fs from "node:fs";
import path from "node:path";
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
