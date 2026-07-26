import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import type { TerminalEvent, TerminalSessionInfo } from "../src/contracts.js";

type TerminalSink = (event: TerminalEvent) => void;

export type PseudoTerminal = Pick<pty.IPty, "write" | "resize" | "kill" | "onData" | "onExit">;
export type PseudoTerminalFactory = (shell: string, args: string[], options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions) => PseudoTerminal;

type ManagedTerminal = {
  info: TerminalSessionInfo;
  pty: PseudoTerminal;
  disposeData: { dispose(): void };
  disposeExit: { dispose(): void };
};

const require = createRequire(import.meta.url);

function nodePtyRoot(): string {
  const entry = require.resolve("node-pty")
    .replaceAll("app.asar", "app.asar.unpacked")
    .replaceAll("node_modules.asar", "node_modules.asar.unpacked");
  return path.dirname(path.dirname(entry));
}

export function ensureNodePtySpawnHelperExecutable(root = nodePtyRoot(), platform = process.platform): string | undefined {
  if (platform !== "darwin") return undefined;
  const candidates = [
    path.join(root, "build", "Release"),
    path.join(root, "build", "Debug"),
    path.join(root, "prebuilds", `${platform}-${process.arch}`),
  ];
  const directory = candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, "pty.node"))
    && fs.existsSync(path.join(candidate, "spawn-helper"))
  ));
  if (!directory) throw new Error("node-pty spawn-helper 缺失，请重新安装应用依赖。");
  const helperPath = path.join(directory, "spawn-helper");
  const mode = fs.statSync(helperPath).mode;
  if ((mode & 0o111) === 0) {
    try {
      fs.chmodSync(helperPath, mode | 0o111);
    } catch (error) {
      throw new Error(`node-pty spawn-helper 不可执行且无法修复权限：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return helperPath;
}

function executable(filePath: string | undefined): filePath is string {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec || "powershell.exe";
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  const shell = candidates.find(executable);
  if (!shell) throw new Error("找不到可执行的 Shell，请检查 SHELL 环境变量。");
  return shell;
}

function boundedDimension(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(maximum, Math.floor(value as number)));
}

function canonicalDirectory(value: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(value));
  } catch {
    throw new Error("终端工作目录无效。");
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error("终端工作目录无效。");
  return resolved;
}

export class TerminalService {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private readonly factory: PseudoTerminalFactory;
  private readonly usesNodePty: boolean;

  constructor(
    private readonly fallbackCwd: string,
    private readonly emit: TerminalSink,
    factory?: PseudoTerminalFactory,
  ) {
    this.usesNodePty = !factory;
    this.factory = factory ?? ((shell, args, options) => pty.spawn(shell, args, options));
  }

  create(cwd?: string, columns?: number, rowCount?: number): TerminalSessionInfo {
    const running = [...this.sessions.values()].filter((session) => session.info.status === "running");
    if (running.length >= 8) throw new Error("最多同时打开 8 个终端。");
    const resolvedCwd = canonicalDirectory(cwd || this.fallbackCwd);
    const shell = defaultShell();
    const cols = boundedDimension(columns, 100, 500);
    const rows = boundedDimension(rowCount, 30, 200);
    const id = randomUUID();
    if (this.usesNodePty) ensureNodePtySpawnHelperExecutable();
    let terminal: PseudoTerminal;
    try {
      terminal = this.factory(shell, [], {
        name: "xterm-256color",
        cwd: resolvedCwd,
        cols,
        rows,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (error) {
      throw new Error(`终端启动失败（${shell}）：${error instanceof Error ? error.message : String(error)}`);
    }
    const info: TerminalSessionInfo = {
      id,
      cwd: resolvedCwd,
      shell,
      title: path.basename(resolvedCwd),
      status: "running",
      cols,
      rows,
    };
    const managed = {
      info,
      pty: terminal,
      disposeData: terminal.onData((data) => this.emit({ type: "terminal.data", id, data })),
      disposeExit: terminal.onExit(({ exitCode, signal }) => {
        info.status = "exited";
        info.exitCode = exitCode;
        this.emit({ type: "terminal.exit", id, exitCode, signal });
      }),
    };
    this.sessions.set(id, managed);
    this.pruneExited();
    return { ...info };
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  write(id: string, data: string): void {
    const session = this.runningSession(id);
    if (typeof data !== "string" || data.length > 64 * 1024) throw new Error("终端输入无效或过长。");
    session.pty.write(data);
  }

  resize(id: string, columns: number, rowCount: number): void {
    const session = this.runningSession(id);
    const cols = boundedDimension(columns, session.info.cols, 500);
    const rows = boundedDimension(rowCount, session.info.rows, 200);
    session.pty.resize(cols, rows);
    session.info.cols = cols;
    session.info.rows = rows;
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.info.status === "running") session.pty.kill();
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.disposeData.dispose();
      session.disposeExit.dispose();
      if (session.info.status === "running") session.pty.kill();
    }
    this.sessions.clear();
  }

  private runningSession(id: string): ManagedTerminal {
    const session = this.sessions.get(id);
    if (!session) throw new Error("找不到该终端会话。");
    if (session.info.status !== "running") throw new Error("终端进程已经退出。");
    return session;
  }

  private pruneExited(): void {
    const exited = [...this.sessions.values()].filter((session) => session.info.status === "exited");
    for (const session of exited.slice(0, Math.max(0, exited.length - 8))) {
      session.disposeData.dispose();
      session.disposeExit.dispose();
      this.sessions.delete(session.info.id);
    }
  }
}
