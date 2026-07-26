import fs from "node:fs";
import path from "node:path";
import type { ResourceSettings, WorkspaceTrustStatus } from "../src/contracts.js";

type StoredResources = ResourceSettings & {
  version: 1;
  trustedProjects: string[];
};

const defaults: StoredResources = {
  version: 1,
  workspaceContextEnabled: true,
  disabledSkills: [],
  trustedProjects: [],
};

const skillNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function uniqueStrings(value: unknown, predicate: (entry: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim()).filter(predicate))];
}

export class ResourceStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "resources.json");
  }

  getSettings(): ResourceSettings {
    const stored = this.read();
    return {
      workspaceContextEnabled: stored.workspaceContextEnabled,
      disabledSkills: [...stored.disabledSkills],
    };
  }

  saveSettings(input: ResourceSettings): ResourceSettings {
    const current = this.read();
    const next = this.validateSettings(input);
    this.write({ ...current, ...next });
    return next;
  }

  isProjectTrusted(cwd: string): boolean {
    return this.read().trustedProjects.includes(canonicalPath(cwd));
  }

  getTrustStatus(cwd: string): WorkspaceTrustStatus {
    const projectPath = canonicalPath(cwd);
    const resourcePaths = this.projectResourcePaths(projectPath);
    return {
      path: projectPath,
      trusted: this.isProjectTrusted(projectPath),
      hasProjectResources: resourcePaths.length > 0,
      resourcePaths,
    };
  }

  setProjectTrusted(cwd: string, trusted: boolean): WorkspaceTrustStatus {
    const projectPath = canonicalPath(cwd);
    const current = this.read();
    const trustedProjects = trusted
      ? [...new Set([...current.trustedProjects, projectPath])]
      : current.trustedProjects.filter((entry) => entry !== projectPath);
    this.write({ ...current, trustedProjects });
    return this.getTrustStatus(projectPath);
  }

  private projectResourcePaths(cwd: string): string[] {
    const candidates = [
      ".pi/settings.json",
      ".pi/skills",
      ".pi/prompts",
      ".pi/extensions",
      ".pi/themes",
      ".pi/mcp.json",
      "AGENTS.md",
      "CLAUDE.md",
    ].map((entry) => path.join(cwd, entry));

    let cursor = cwd;
    while (true) {
      candidates.push(path.join(cursor, ".agents", "skills"));
      if (fs.existsSync(path.join(cursor, ".git"))) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return [...new Set(candidates.filter((entry) => fs.existsSync(entry)).map(canonicalPath))];
  }

  private read(): StoredResources {
    try {
      if (!fs.existsSync(this.filePath)) return { ...defaults };
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      const settings = this.validateSettings(value);
      return {
        version: 1,
        ...settings,
        trustedProjects: uniqueStrings(value.trustedProjects, (entry) => path.isAbsolute(entry)).map(canonicalPath),
      };
    } catch {
      return { ...defaults };
    }
  }

  private validateSettings(value: unknown): ResourceSettings {
    if (!value || typeof value !== "object") throw new Error("资源设置格式无效。");
    const input = value as Record<string, unknown>;
    if (typeof input.workspaceContextEnabled !== "boolean") throw new Error("工作区上下文设置无效。");
    return {
      workspaceContextEnabled: input.workspaceContextEnabled,
      disabledSkills: uniqueStrings(input.disabledSkills, (entry) => skillNamePattern.test(entry)),
    };
  }

  private write(value: StoredResources): void {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
