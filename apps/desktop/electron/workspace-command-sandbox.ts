import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { unpackedAsarPath } from "./asar-path.js";
import os from "node:os";
import path from "node:path";
import {
  createLocalBashOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

const allowedDomains = [
  "github.com",
  "*.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "npmjs.org",
  "*.npmjs.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
];

const require = createRequire(import.meta.url);

function packagedSeccompConfig(): SandboxRuntimeConfig["seccomp"] {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) return undefined;
  const packageRoot = path.dirname(unpackedAsarPath(require.resolve("@anthropic-ai/sandbox-runtime/package.json")));
  const binaryRoot = path.join(packageRoot, "vendor", "seccomp", process.arch);
  return {
    bpfPath: path.join(binaryRoot, "unix-block.bpf"),
    applyPath: path.join(binaryRoot, "apply-seccomp"),
  };
}

function sandboxConfig(cwd: string): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: [
        "~/.ssh",
        "~/.aws",
        "~/.gnupg",
        "~/.kube",
        "~/.config/gcloud",
        "~/Library/Keychains",
      ],
      allowWrite: [path.resolve(cwd), "/tmp", os.tmpdir()],
      denyWrite: [".env", ".env.*", "*.pem", "*.key"],
      allowGitConfig: false,
    },
    seccomp: packagedSeccompConfig(),
  };
}

export class WorkspaceCommandSandbox {
  private readonly localOperations = createLocalBashOperations();
  private initializedCwd?: string;
  private failedCwd?: string;
  private initialization?: Promise<void>;
  private readonly supported: boolean;

  constructor() {
    const sandboxPlatform = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "unknown";
    this.supported = sandboxPlatform !== "unknown"
      && SandboxManager.isSupportedPlatform(sandboxPlatform)
      && SandboxManager.checkDependencies();
  }

  isAvailable(): boolean {
    return this.supported && !this.failedCwd;
  }

  async prepare(cwd: string): Promise<boolean> {
    if (!this.supported || this.failedCwd === path.resolve(cwd)) return false;
    try {
      await this.ensureInitialized(cwd);
      return true;
    } catch {
      return false;
    }
  }

  createOperations(): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        if (!this.supported || this.failedCwd === path.resolve(cwd)) {
          return this.localOperations.exec(command, cwd, options);
        }
        try {
          await this.ensureInitialized(cwd);
        } catch {
          return this.localOperations.exec(command, cwd, options);
        }
        const shellPath = process.env.SHELL || "/bin/bash";
        const wrappedCommand = await SandboxManager.wrapWithSandbox(command, shellPath, undefined, options.signal);
        return this.spawn(shellPath, wrappedCommand, cwd, options);
      },
    };
  }

  async reset(): Promise<void> {
    if (this.initialization) await this.initialization.catch(() => undefined);
    this.initialization = undefined;
    this.initializedCwd = undefined;
    this.failedCwd = undefined;
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
  }

  private async ensureInitialized(cwd: string): Promise<void> {
    const resolvedCwd = path.resolve(cwd);
    if (this.initializedCwd === resolvedCwd && this.initialization) return this.initialization;
    this.initializedCwd = resolvedCwd;
    this.initialization = (async () => {
      if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
      await SandboxManager.initialize(sandboxConfig(resolvedCwd));
    })();
    try {
      await this.initialization;
    } catch (error) {
      this.failedCwd = resolvedCwd;
      this.initializedCwd = undefined;
      this.initialization = undefined;
      throw new Error(`命令沙箱初始化失败，已阻止执行：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private spawn(
    shellPath: string,
    wrappedCommand: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(shellPath, ["-c", wrappedCommand], {
        cwd,
        detached: true,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      const timeoutHandle = options.timeout && options.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            this.killProcessTree(child.pid, child.kill.bind(child));
          }, options.timeout * 1000)
        : undefined;
      const finish = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", abort);
      };
      const abort = () => this.killProcessTree(child.pid, child.kill.bind(child));

      child.stdout?.on("data", options.onData);
      child.stderr?.on("data", options.onData);
      child.once("error", (error) => {
        finish();
        reject(error);
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("close", (exitCode) => {
        finish();
        if (options.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
        else resolve({ exitCode });
      });
    });
  }

  private killProcessTree(pid: number | undefined, fallback: () => boolean): void {
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Fall through when the process group has already exited.
      }
    }
    fallback();
  }
}
