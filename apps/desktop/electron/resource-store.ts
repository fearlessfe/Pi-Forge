import fs from "node:fs";
import path from "node:path";
import type { ProjectResourceSettings, ResourceSettings, WorkspaceTrustStatus } from "../src/contracts.js";

type StoredProjectResourceSettings = {
  skillOverrides: Record<string, boolean>;
  mcpServerOverrides: Record<string, boolean>;
};

type StoredResources = ResourceSettings & {
  version: 1;
  trustedProjects: string[];
  knownWorkspaces: string[];
  projectSettings: Record<string, StoredProjectResourceSettings>;
};

const defaults: StoredResources = {
  version: 1,
  workspaceContextEnabled: true,
  disabledSkills: [],
  trustedProjects: [],
  knownWorkspaces: [],
  projectSettings: {},
};

const skillNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const mcpServerKeyPattern = /^(?:user|project):[^\0\r\n]{1,2048}$/;

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

function booleanRecord(value: unknown, predicate: (entry: string) => boolean): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (predicate(key) && typeof enabled === "boolean") output[key] = enabled;
  }
  return output;
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

  getProjectSettings(cwd: string): ProjectResourceSettings {
    const projectPath = canonicalPath(cwd);
    const settings = this.read().projectSettings[projectPath];
    return {
      cwd: projectPath,
      skillOverrides: { ...(settings?.skillOverrides ?? {}) },
      mcpServerOverrides: { ...(settings?.mcpServerOverrides ?? {}) },
    };
  }

  setProjectSkillEnabled(cwd: string, name: string, enabled: boolean): ProjectResourceSettings {
    if (!skillNamePattern.test(name)) throw new Error("Skill 名称无效。");
    return this.setProjectOverride(cwd, "skillOverrides", name, enabled);
  }

  setProjectMcpServerEnabled(cwd: string, key: string, enabled: boolean): ProjectResourceSettings {
    if (!mcpServerKeyPattern.test(key)) throw new Error("MCP Server 无效。");
    return this.setProjectOverride(cwd, "mcpServerOverrides", key, enabled);
  }

  isProjectSkillEnabled(name: string, cwd?: string): boolean {
    return !cwd || this.getProjectSettings(cwd).skillOverrides[name] !== false;
  }

  isProjectMcpServerEnabled(key: string, cwd?: string): boolean {
    return !cwd || this.getProjectSettings(cwd).mcpServerOverrides[key] !== false;
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

  addKnownWorkspace(cwd: string): string {
    const workspacePath = canonicalPath(cwd);
    const current = this.read();
    if (!current.knownWorkspaces.includes(workspacePath)) {
      this.write({ ...current, knownWorkspaces: [...current.knownWorkspaces, workspacePath] });
    }
    return workspacePath;
  }

  isKnownWorkspace(cwd: string): boolean {
    return this.read().knownWorkspaces.includes(canonicalPath(cwd));
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
        knownWorkspaces: uniqueStrings(value.knownWorkspaces, (entry) => path.isAbsolute(entry)).map(canonicalPath),
        projectSettings: this.validateProjectSettings(value.projectSettings),
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

  private validateProjectSettings(value: unknown): Record<string, StoredProjectResourceSettings> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const output: Record<string, StoredProjectResourceSettings> = {};
    for (const [project, settings] of Object.entries(value as Record<string, unknown>)) {
      if (!path.isAbsolute(project) || !settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      const input = settings as Record<string, unknown>;
      output[canonicalPath(project)] = {
        skillOverrides: booleanRecord(input.skillOverrides, (entry) => skillNamePattern.test(entry)),
        mcpServerOverrides: booleanRecord(input.mcpServerOverrides, (entry) => mcpServerKeyPattern.test(entry)),
      };
    }
    return output;
  }

  private setProjectOverride(
    cwd: string,
    kind: keyof StoredProjectResourceSettings,
    key: string,
    enabled: boolean,
  ): ProjectResourceSettings {
    const projectPath = canonicalPath(cwd);
    const current = this.read();
    const previous = current.projectSettings[projectPath] ?? { skillOverrides: {}, mcpServerOverrides: {} };
    const overrides = { ...previous[kind] };
    if (enabled) delete overrides[key];
    else overrides[key] = false;
    const next = { ...previous, [kind]: overrides };
    const empty = Object.keys(next.skillOverrides).length === 0 && Object.keys(next.mcpServerOverrides).length === 0;
    const projectSettings = { ...current.projectSettings };
    if (empty) delete projectSettings[projectPath];
    else projectSettings[projectPath] = next;
    this.write({ ...current, projectSettings });
    return this.getProjectSettings(projectPath);
  }

  private write(value: StoredResources): void {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
