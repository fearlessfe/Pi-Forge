import fs from "node:fs";
import path from "node:path";
import type { PermissionMode } from "../src/contracts.js";

export type PermissionGrant = "sandbox-bypass";

export type PermissionDecision = {
  action: "allow" | "ask";
  kind: "safe" | "workspace-write" | "outside-workspace" | "shell" | "dangerous-shell";
  reason: string;
  allowForRun?: PermissionGrant;
};

type ToolCallContext = {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  mode: PermissionMode;
  sandboxAvailable: boolean;
  runGrants: ReadonlySet<PermissionGrant>;
};

const workspaceWriteTools = new Set(["edit", "write"]);
const pathTools = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const dangerousShellPatterns: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|[;&|]\s*)rm\s+[^\n;&|]*(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$)/i, label: "递归删除文件" },
  { pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|checkout\s+--\s+\.)(?:\s|$)/i, label: "丢弃 Git 工作区变更" },
  { pattern: /\b(?:sudo|doas)\b/i, label: "提升系统权限" },
  { pattern: /\b(?:chmod|chown)\b[^\n]*(?:-R|--recursive|777)\b/i, label: "递归修改文件权限" },
  { pattern: /\bfind\b[^\n]*(?:-delete|-exec\s+rm)\b/i, label: "批量删除文件" },
  { pattern: /\b(?:mkfs|diskutil\s+erase|dd\s+[^\n]*\bof=)\b/i, label: "直接修改磁盘或设备" },
];

export function isInsideWorkspace(cwd: string, candidate: string): boolean {
  const root = fs.realpathSync(cwd);
  const absolute = path.resolve(cwd, candidate);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const resolvedExisting = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  const resolved = path.resolve(resolvedExisting, path.relative(existing, absolute));
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function dangerousShellReason(command: string): string | undefined {
  return dangerousShellPatterns.find(({ pattern }) => pattern.test(command))?.label;
}

export function decideToolPermission(context: ToolCallContext): PermissionDecision {
  const candidatePath = pathTools.has(context.toolName) && typeof context.input.path === "string"
    ? context.input.path
    : undefined;
  if (candidatePath && !isInsideWorkspace(context.cwd, candidatePath)) {
    return {
      action: "ask",
      kind: "outside-workspace",
      reason: "工具将访问所选工作区之外的路径。",
    };
  }

  if (context.toolName === "bash") {
    const command = typeof context.input.command === "string" ? context.input.command : "";
    const dangerousReason = dangerousShellReason(command);
    if (dangerousReason) {
      return { action: "ask", kind: "dangerous-shell", reason: dangerousReason };
    }
    if (context.mode === "balanced" && context.sandboxAvailable) {
      return { action: "allow", kind: "safe", reason: "命令将在受限的工作区沙箱中运行。" };
    }
    if (context.mode === "balanced" && context.runGrants.has("sandbox-bypass")) {
      return { action: "allow", kind: "shell", reason: "用户已允许本次任务运行未沙箱化命令。" };
    }
    return {
      action: "ask",
      kind: "shell",
      reason: context.mode === "strict"
        ? "严格模式要求每次执行 Shell 命令前确认。"
        : "当前系统无法启用命令沙箱，需要确认后运行。",
      allowForRun: context.mode === "balanced" ? "sandbox-bypass" : undefined,
    };
  }

  if (workspaceWriteTools.has(context.toolName)) {
    if (context.mode === "balanced") {
      return { action: "allow", kind: "workspace-write", reason: "文件修改位于所选工作区内。" };
    }
    return {
      action: "ask",
      kind: "workspace-write",
      reason: "严格模式要求每次修改文件前确认。",
    };
  }

  return { action: "allow", kind: "safe", reason: "工具调用位于所选工作区内。" };
}
