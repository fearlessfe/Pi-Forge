import fs from "node:fs";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCommandSandbox } from "./workspace-command-sandbox.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("WorkspaceCommandSandbox", () => {
  it("allows workspace writes and blocks writes elsewhere", async () => {
    const sandbox = new WorkspaceCommandSandbox();
    if (!sandbox.isAvailable()) return;

    const workspace = fs.mkdtempSync(path.join(process.cwd(), ".sandbox-workspace-"));
    const escaped = path.join(process.cwd(), `.sandbox-escape-${process.pid}`);
    cleanupPaths.push(workspace, escaped);
    if (!await sandbox.prepare(workspace)) return;
    const operations = sandbox.createOperations();
    const onData = () => {};

    try {
      const inside = await operations.exec("touch allowed.txt", workspace, { onData });
      expect(inside.exitCode).toBe(0);
      expect(fs.existsSync(path.join(workspace, "allowed.txt"))).toBe(true);

      const outside = await operations.exec(`touch ${JSON.stringify(escaped)}`, workspace, { onData });
      expect(outside.exitCode).not.toBe(0);
      expect(fs.existsSync(escaped)).toBe(false);
    } finally {
      await sandbox.reset();
    }
  }, 15_000);

  it("falls back to local execution when sandbox dependencies are unavailable", async () => {
    vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(false);
    const workspace = fs.mkdtempSync(path.join(process.cwd(), ".sandbox-fallback-"));
    cleanupPaths.push(workspace);
    const sandbox = new WorkspaceCommandSandbox();
    const output: string[] = [];

    expect(sandbox.isAvailable()).toBe(false);
    expect(await sandbox.prepare(workspace)).toBe(false);
    const result = await sandbox.createOperations().exec("printf fallback-ok", workspace, {
      onData: (data) => output.push(String(data)),
    });
    expect(result.exitCode).toBe(0);
    expect(output.join("")).toContain("fallback-ok");
  });

  it("initializes once per workspace, wraps commands, and resets cleanly", async () => {
    vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(true);
    vi.spyOn(SandboxManager, "checkDependencies").mockReturnValue(true);
    const initialize = vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    const wrap = vi.spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (command) => command);
    vi.spyOn(SandboxManager, "isSandboxingEnabled").mockReturnValue(false);
    const reset = vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    const workspace = fs.mkdtempSync(path.join(process.cwd(), ".sandbox-success-"));
    cleanupPaths.push(workspace);
    const sandbox = new WorkspaceCommandSandbox();
    const output: string[] = [];

    expect(await sandbox.prepare(workspace)).toBe(true);
    expect(await sandbox.prepare(workspace)).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
    const result = await sandbox.createOperations().exec("printf sandbox-ok", workspace, {
      onData: (data) => output.push(String(data)),
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(output.join("")).toContain("sandbox-ok");
    expect(wrap).toHaveBeenCalledWith("printf sandbox-ok", expect.any(String), undefined, undefined);

    vi.mocked(SandboxManager.isSandboxingEnabled).mockReturnValue(true);
    await sandbox.reset();
    expect(reset).toHaveBeenCalledOnce();
    expect(sandbox.isAvailable()).toBe(true);
  });

  it("marks a failed workspace and uses local execution on later commands", async () => {
    vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(true);
    vi.spyOn(SandboxManager, "checkDependencies").mockReturnValue(true);
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValueOnce(new Error("runtime unavailable"));
    vi.spyOn(SandboxManager, "isSandboxingEnabled").mockReturnValue(false);
    const workspace = fs.mkdtempSync(path.join(process.cwd(), ".sandbox-failed-"));
    cleanupPaths.push(workspace);
    const sandbox = new WorkspaceCommandSandbox();
    const output: string[] = [];

    expect(await sandbox.prepare(workspace)).toBe(false);
    expect(sandbox.isAvailable()).toBe(false);
    expect(await sandbox.prepare(workspace)).toBe(false);
    const result = await sandbox.createOperations().exec("printf local-after-failure", workspace, {
      onData: (data) => output.push(String(data)),
    });
    expect(result.exitCode).toBe(0);
    expect(output.join("")).toContain("local-after-failure");
    expect(initialize).toHaveBeenCalledOnce();

    await sandbox.reset();
    expect(sandbox.isAvailable()).toBe(true);
  });

  it("aborts and times out wrapped process trees with explicit errors", async () => {
    vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(true);
    vi.spyOn(SandboxManager, "checkDependencies").mockReturnValue(true);
    vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    vi.spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (command) => command);
    vi.spyOn(SandboxManager, "isSandboxingEnabled").mockReturnValue(false);
    const workspace = fs.mkdtempSync(path.join(process.cwd(), ".sandbox-interrupt-"));
    cleanupPaths.push(workspace);
    const sandbox = new WorkspaceCommandSandbox();
    const operations = sandbox.createOperations();

    await expect(operations.exec("sleep 2", workspace, { onData: () => {}, timeout: 0.01, env: process.env })).rejects.toThrow("timeout:0.01");

    const controller = new AbortController();
    const running = operations.exec("sleep 2", workspace, { onData: () => {}, signal: controller.signal, env: process.env });
    controller.abort();
    await expect(running).rejects.toThrow("aborted");
  });
});
