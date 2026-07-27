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
    const root = directory("node-pty");
    const prebuild = path.join(root, "prebuilds", `darwin-${process.arch}`);
    fs.mkdirSync(prebuild, { recursive: true });
    fs.writeFileSync(path.join(prebuild, "pty.node"), "native-placeholder");
    const helper = path.join(prebuild, "spawn-helper");
    fs.writeFileSync(helper, "helper", { mode: 0o644 });

    expect(ensureNodePtySpawnHelperExecutable(root, "darwin")).toBe(helper);
    expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
  });

  it("does not require the macOS-only spawn-helper on Linux or Windows", () => {
    const root = directory("node-pty-without-helper");
    expect(ensureNodePtySpawnHelperExecutable(root, "linux")).toBeUndefined();
    expect(ensureNodePtySpawnHelperExecutable(root, "win32")).toBeUndefined();
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

  it("rejects missing helpers and reports permission repair failures", () => {
    const missingRoot = directory("missing-helper");
    expect(() => ensureNodePtySpawnHelperExecutable(missingRoot, "darwin")).toThrow("spawn-helper 缺失");

    const root = directory("broken-helper");
    const release = path.join(root, "build", "Release");
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(release, "pty.node"), "native-placeholder");
    fs.writeFileSync(path.join(release, "spawn-helper"), "helper", { mode: 0o644 });
    const chmod = vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => { throw new Error("read-only filesystem"); });
    expect(() => ensureNodePtySpawnHelperExecutable(root, "darwin")).toThrow("read-only filesystem");
    chmod.mockRestore();
  });

  it("bounds dimensions and rejects invalid session operations", () => {
    const workspace = directory("validation");
    const file = path.join(workspace, "not-a-directory");
    fs.writeFileSync(file, "x");
    const terminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: () => ({ dispose: vi.fn() }),
      onExit: () => ({ dispose: vi.fn() }),
    } satisfies PseudoTerminal;
    const factory = vi.fn(() => terminal);
    const service = new TerminalService(workspace, () => {}, factory);

    expect(() => service.create(file)).toThrow("终端工作目录无效");
    const session = service.create(undefined, Number.POSITIVE_INFINITY, 1);
    expect(session).toMatchObject({ cols: 100, rows: 2, title: path.basename(workspace) });
    service.resize(session.id, 999, Number.NaN);
    expect(terminal.resize).toHaveBeenCalledWith(500, 2);
    expect(() => service.write(session.id, 42 as unknown as string)).toThrow("终端输入无效");
    expect(() => service.resize("missing", 80, 24)).toThrow("找不到该终端");
    service.kill("missing");
    service.kill(session.id);
    expect(terminal.kill).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("retains only the latest eight exited sessions and does not kill exited PTYs", () => {
    const workspace = directory("pruning");
    const exits: Array<(event: { exitCode: number; signal?: number }) => void> = [];
    const kills: Array<ReturnType<typeof vi.fn>> = [];
    const disposed: Array<ReturnType<typeof vi.fn>> = [];
    const factory: PseudoTerminalFactory = () => {
      const kill = vi.fn();
      kills.push(kill);
      return {
        write: vi.fn(),
        resize: vi.fn(),
        kill,
        onData: () => {
          const dispose = vi.fn();
          disposed.push(dispose);
          return { dispose };
        },
        onExit: (listener) => {
          exits.push(listener);
          const dispose = vi.fn();
          disposed.push(dispose);
          return { dispose };
        },
      };
    };
    const service = new TerminalService(workspace, () => {}, factory);

    for (let index = 0; index < 10; index += 1) {
      service.create();
      exits[index]({ exitCode: index });
    }
    // Pruning happens after the next create; the first exited session is
    // removed once a ninth completed terminal exists.
    expect(service.list()).toHaveLength(9);
    expect(service.list().map((session) => session.exitCode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    service.kill(service.list()[0].id);
    expect(kills.every((kill) => !kill.mock.calls.length)).toBe(true);
    service.dispose();
    expect(disposed.some((dispose) => dispose.mock.calls.length > 0)).toBe(true);
    expect(kills.every((kill) => !kill.mock.calls.length)).toBe(true);
  });
});
