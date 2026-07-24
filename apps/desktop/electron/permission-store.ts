import fs from "node:fs";
import path from "node:path";
import type { PermissionMode, PermissionSettings } from "../src/contracts.js";

export const defaultPermissionSettings: PermissionSettings = { mode: "balanced" };

const permissionModes = new Set<PermissionMode>(["balanced", "strict"]);

export class PermissionStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "permissions.json");
  }

  get(): PermissionSettings {
    try {
      if (!fs.existsSync(this.filePath)) return defaultPermissionSettings;
      return this.validate(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      return defaultPermissionSettings;
    }
  }

  save(input: PermissionSettings): PermissionSettings {
    const next = this.validate(input);
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    return next;
  }

  private validate(value: unknown): PermissionSettings {
    if (!value || typeof value !== "object") throw new Error("权限设置格式无效。");
    const mode = (value as Record<string, unknown>).mode;
    if (typeof mode !== "string" || !permissionModes.has(mode as PermissionMode)) {
      throw new Error("不支持的权限模式。");
    }
    return { mode: mode as PermissionMode };
  }
}
