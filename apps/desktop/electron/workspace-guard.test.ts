import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceStore } from "./resource-store.js";
import { requireKnownWorkspace, resolveWorkspaceFileReference, seedKnownWorkspacesFromSessions } from "./workspace-guard.js";

const cleanup: string[] = [];

function directory(name: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  cleanup.push(target);
  return target;
}

function writeSession(sessionDir: string, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(sessionDir, name), `${lines.join("\n")}\n`);
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("requireKnownWorkspace", () => {
  it("accepts registered workspaces and rejects unregistered directories", () => {
    const userData = directory("pi-guard-user");
    const workspace = directory("pi-guard-workspace");
    const other = directory("pi-guard-other");
    const store = new ResourceStore(userData);
    store.addKnownWorkspace(workspace);

    expect(() => requireKnownWorkspace(store, workspace)).not.toThrow();
    expect(() => requireKnownWorkspace(store, other)).toThrow("该目录不是已打开的工作区");
  });

  it("never throws on nonexistent paths", () => {
    const userData = directory("pi-guard-user");
    const store = new ResourceStore(userData);
    const missing = path.join(directory("pi-guard-parent"), "deleted");

    expect(() => requireKnownWorkspace(store, missing)).toThrow("该目录不是已打开的工作区");
  });
});

describe("resolveWorkspaceFileReference", () => {
  it("resolves relative, absolute, encoded file URL, and fragment references inside a known workspace", () => {
    const store = new ResourceStore(directory("pi-file-user"));
    const workspace = directory("pi-file-workspace");
    const nested = path.join(workspace, "docs");
    const file = path.join(nested, "a guide.md");
    fs.mkdirSync(nested);
    fs.writeFileSync(file, "guide");
    store.addKnownWorkspace(workspace);

    expect(resolveWorkspaceFileReference(store, workspace, "docs/a%20guide.md")).toBe(fs.realpathSync(file));
    expect(resolveWorkspaceFileReference(store, workspace, `${pathToFileURL(file).href}#L1`)).toBe(fs.realpathSync(file));
    expect(resolveWorkspaceFileReference(store, workspace, file)).toBe(fs.realpathSync(file));
    expect(resolveWorkspaceFileReference(store, workspace, `${file}#L12`)).toBe(fs.realpathSync(file));
    expect(resolveWorkspaceFileReference(store, workspace, "docs/a%20guide.md:12:4")).toBe(fs.realpathSync(file));
  });

  it("rejects unknown workspaces, missing files, directories, and dangerous protocols", () => {
    const store = new ResourceStore(directory("pi-file-user"));
    const workspace = directory("pi-file-workspace");
    const file = path.join(workspace, "README.md");
    fs.writeFileSync(file, "readme");

    expect(() => resolveWorkspaceFileReference(store, workspace, file)).toThrow("不是已打开的工作区");
    store.addKnownWorkspace(workspace);
    expect(() => resolveWorkspaceFileReference(store, workspace, "missing.md")).toThrow("不存在或无法访问");
    expect(() => resolveWorkspaceFileReference(store, workspace, ".")).toThrow("不是文件");
    expect(() => resolveWorkspaceFileReference(store, workspace, "https://example.com/file")).toThrow("只允许本地文件路径");
    expect(() => resolveWorkspaceFileReference(store, workspace, "data:text/plain,secret")).toThrow("只允许本地文件路径");
    expect(() => resolveWorkspaceFileReference(store, workspace, "//example.com/secret")).toThrow("只允许本地文件路径");
    expect(() => resolveWorkspaceFileReference(store, workspace, `${file}?raw=1`)).toThrow("只允许本地文件路径");
  });

  it("rejects traversal and symlink escapes after realpath resolution", () => {
    const store = new ResourceStore(directory("pi-file-user"));
    const workspace = directory("pi-file-workspace");
    const outside = directory("pi-file-outside");
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");
    fs.symlinkSync(secret, path.join(workspace, "linked-secret"));
    store.addKnownWorkspace(workspace);

    expect(() => resolveWorkspaceFileReference(store, workspace, `../${path.basename(outside)}/secret.txt`)).toThrow("工作区之外");
    expect(() => resolveWorkspaceFileReference(store, workspace, "linked-secret")).toThrow("工作区之外");
    expect(() => resolveWorkspaceFileReference(store, workspace, pathToFileURL(secret).href)).toThrow("工作区之外");
  });
});

describe("seedKnownWorkspacesFromSessions", () => {
  it("registers cwds from persisted session headers", () => {
    const userData = directory("pi-guard-user");
    const sessionDir = directory("pi-guard-sessions");
    const alpha = directory("pi-guard-alpha");
    const beta = directory("pi-guard-beta");
    writeSession(sessionDir, "2026-01-01_alpha.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "conversation-1", cwd: alpha }),
      JSON.stringify({ type: "model_change", id: "c1" }),
    ]);
    writeSession(sessionDir, "2026-01-02_beta.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "conversation-2", cwd: beta }),
    ]);
    writeSession(sessionDir, "notes.txt", [JSON.stringify({ type: "session", cwd: "/ignored" })]);
    writeSession(sessionDir, "broken.jsonl", ["not json"]);
    writeSession(sessionDir, "relative.jsonl", [JSON.stringify({ type: "session", cwd: "relative/path" })]);
    writeSession(sessionDir, "other.jsonl", [JSON.stringify({ type: "model_change", cwd: alpha })]);

    const store = new ResourceStore(userData);
    expect(seedKnownWorkspacesFromSessions(store, [sessionDir])).toBe(2);
    expect(store.isKnownWorkspace(alpha)).toBe(true);
    expect(store.isKnownWorkspace(beta)).toBe(true);
    expect(new ResourceStore(userData).isKnownWorkspace(alpha)).toBe(true);
    expect(store.isKnownWorkspace("/ignored")).toBe(false);
  });

  it("does not re-count already known workspaces", () => {
    const userData = directory("pi-guard-user");
    const sessionDir = directory("pi-guard-sessions");
    const workspace = directory("pi-guard-workspace");
    writeSession(sessionDir, "a.jsonl", [JSON.stringify({ type: "session", cwd: workspace })]);
    writeSession(sessionDir, "b.jsonl", [JSON.stringify({ type: "session", cwd: workspace })]);

    const store = new ResourceStore(userData);
    store.addKnownWorkspace(workspace);
    expect(seedKnownWorkspacesFromSessions(store, [sessionDir])).toBe(0);
  });

  it("ignores missing session directories", () => {
    const userData = directory("pi-guard-user");
    const store = new ResourceStore(userData);
    const missing = path.join(directory("pi-guard-parent"), "no-sessions");

    expect(seedKnownWorkspacesFromSessions(store, [missing])).toBe(0);
  });
});
