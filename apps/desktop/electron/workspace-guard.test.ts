import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceStore } from "./resource-store.js";
import { requireKnownWorkspace, seedKnownWorkspacesFromSessions } from "./workspace-guard.js";

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
