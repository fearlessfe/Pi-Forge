import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "../src/contracts.js";
import { ensureNodePtySpawnHelperExecutable, TerminalService, type PseudoTerminal, type PseudoTerminalFactory } from "./terminal-service.js";

const cleanup: string[] = [];

function directory(label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `pi-terminal-${label}-`));
  cleanup.push(target);
  return target;
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("TerminalService", () => {
  it("repairs a packaged node-pty spawn-helper that lost its executable bit", () => {
    if (process.platform === "win32") return;
    const root = directory("node-pty");
    const prebuild = path.join(root, "prebuilds", `${process.platform}-${process.arch}`);
    fs.mkdirSync(prebuild, { recursive: true });
    fs.writeFileSync(path.join(prebuild, "pty.node"), "native-placeholder");
    const helper = path.join(prebuild, "spawn-helper");
    fs.writeFileSync(helper, "helper", { mode: 0o644 });

    expect(ensureNodePtySpawnHelperExecutable(root)).toBe(helper);
    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });

  it("owns PTY lifecycle, input, resize and renderer events", () => {
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const write = vi.fn();
    const resize = vi.fn();
    const kill = vi.fn();
    const factory: PseudoTerminalFactory = vi.fn((_shell, _args, options) => {
      expect(options.cwd).toBe(fs.realpathSync(workspace));
      expect(options.env?.TERM).toBe("xterm-256color");
      return {
        write,
        resize,
        kill,
        onData: (listener) => { onData = listener; return { dispose: vi.fn() }; },
        onExit: (listener) => { onExit = listener; return { dispose: vi.fn() }; },
      } satisfies PseudoTerminal;
    });
    const workspace = directory("workspace");
    const events: TerminalEvent[] = [];
    const service = new TerminalService(workspace, (event) => events.push(event), factory);

    const session = service.create(workspace, 120, 40);
    expect(session).toMatchObject({ cwd: fs.realpathSync(workspace), status: "running", cols: 120, rows: 40 });
    service.write(session.id, "echo hello\r");
    service.resize(session.id, 130, 44);
    expect(write).toHaveBeenCalledWith("echo hello\r");
    expect(resize).toHaveBeenCalledWith(130, 44);

    onData?.("hello\r\n");
    expect(events).toContainEqual({ type: "terminal.data", id: session.id, data: "hello\r\n" });
    onExit?.({ exitCode: 7, signal: 15 });
    expect(events).toContainEqual({ type: "terminal.exit", id: session.id, exitCode: 7, signal: 15 });
    expect(service.list()[0]).toMatchObject({ status: "exited", exitCode: 7, cols: 130, rows: 44 });
    expect(() => service.write(session.id, "pwd\r")).toThrow("已经退出");
    service.dispose();
  });

  it("rejects invalid directories, oversized input and more than eight running terminals", () => {
    const workspace = directory("limits");
    const terminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: () => ({ dispose: vi.fn() }),
      onExit: () => ({ dispose: vi.fn() }),
    } satisfies PseudoTerminal;
    const service = new TerminalService(workspace, () => {}, () => terminal);
    expect(() => service.create(path.join(workspace, "missing"))).toThrow("终端工作目录无效");
    const first = service.create();
    expect(() => service.write(first.id, "x".repeat(64 * 1024 + 1))).toThrow("过长");
    for (let index = 1; index < 8; index += 1) service.create();
    expect(() => service.create()).toThrow("最多同时打开 8 个终端");
    service.dispose();
    expect(terminal.kill).toHaveBeenCalled();
  });

  it("adds the selected shell to PTY startup failures", () => {
    const workspace = directory("spawn-error");
    const service = new TerminalService(workspace, () => {}, () => { throw new Error("posix_spawnp failed"); });
    expect(() => service.create()).toThrow(/终端启动失败（.+）：posix_spawnp failed/);
  });
});
