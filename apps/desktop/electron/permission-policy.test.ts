import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dangerousShellReason, decideToolPermission, isInsideWorkspace, type PermissionGrant } from "./permission-policy.js";

const directories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-permission-${label}-`));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("permission policy", () => {
  it("allows workspace writes in balanced mode and asks in strict mode", () => {
    const cwd = temporaryDirectory("workspace-write");
    const base = { toolName: "write", input: { path: "src/new.ts" }, cwd, sandboxAvailable: true, runGrants: new Set<PermissionGrant>() };

    expect(decideToolPermission({ ...base, mode: "balanced" })).toMatchObject({ action: "allow", kind: "workspace-write" });
    expect(decideToolPermission({ ...base, mode: "strict" })).toMatchObject({ action: "ask", kind: "workspace-write" });
  });

  it("asks before any tool follows a path outside the workspace, including symlinks", () => {
    const cwd = temporaryDirectory("workspace-boundary");
    const outside = temporaryDirectory("outside");
    fs.symlinkSync(outside, path.join(cwd, "linked-outside"));

    expect(isInsideWorkspace(cwd, "src/new.ts")).toBe(true);
    expect(isInsideWorkspace(cwd, path.join(outside, "secret.txt"))).toBe(false);
    expect(isInsideWorkspace(cwd, "linked-outside/secret.txt")).toBe(false);
    expect(decideToolPermission({
      toolName: "read",
      input: { path: "linked-outside/secret.txt" },
      cwd,
      mode: "balanced",
      sandboxAvailable: true,
      runGrants: new Set(),
    })).toMatchObject({ action: "ask", kind: "outside-workspace" });
  });

  it("allows ordinary shell commands only when sandboxed or approved for the run", () => {
    const cwd = temporaryDirectory("shell");
    const base = { toolName: "bash", input: { command: "pnpm test" }, cwd, mode: "balanced" as const };

    expect(decideToolPermission({ ...base, sandboxAvailable: true, runGrants: new Set() })).toMatchObject({ action: "allow" });
    expect(decideToolPermission({ ...base, sandboxAvailable: false, runGrants: new Set() })).toMatchObject({
      action: "ask",
      allowForRun: "sandbox-bypass",
    });
    expect(decideToolPermission({ ...base, sandboxAvailable: false, runGrants: new Set(["sandbox-bypass" as const]) })).toMatchObject({ action: "allow" });
  });

  it("always asks before destructive shell commands", () => {
    const cwd = temporaryDirectory("dangerous-shell");
    for (const command of ["rm -rf dist", "git reset --hard HEAD", "sudo npm install -g foo", "find . -delete"]) {
      expect(dangerousShellReason(command)).toBeTruthy();
      expect(decideToolPermission({
        toolName: "bash",
        input: { command },
        cwd,
        mode: "balanced",
        sandboxAvailable: true,
        runGrants: new Set(["sandbox-bypass"]),
      })).toEqual(expect.objectContaining({ action: "ask", kind: "dangerous-shell" }));
    }
  });

  it("asks before MCP calls and supports a balanced per-server run grant", () => {
    const cwd = temporaryDirectory("mcp");
    const base = { toolName: "mcp__search_api__web_search", input: { query: "private context" }, cwd, sandboxAvailable: true };
    const first = decideToolPermission({ ...base, mode: "balanced", runGrants: new Set() });
    expect(first).toMatchObject({ action: "ask", allowForRun: "mcp:search_api" });
    expect(decideToolPermission({ ...base, mode: "balanced", runGrants: new Set(["mcp:search_api"]) })).toMatchObject({ action: "allow" });
    expect(decideToolPermission({ ...base, mode: "strict", runGrants: new Set(["mcp:search_api"]) })).toMatchObject({ action: "ask", allowForRun: undefined });
  });
});
