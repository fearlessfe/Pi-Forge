import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCommandSandbox } from "./workspace-command-sandbox.js";

const cleanupPaths: string[] = [];

afterEach(() => {
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
});
