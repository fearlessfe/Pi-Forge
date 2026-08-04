import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceStore } from "./resource-store.js";

const cleanup: string[] = [];

function directory(name: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  cleanup.push(target);
  return target;
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("ResourceStore", () => {
  it("defaults projects to untrusted and persists canonical trust decisions", () => {
    const userData = directory("pi-resource-user");
    const project = directory("pi-resource-project");
    const store = new ResourceStore(userData);

    expect(store.getTrustStatus(project).trusted).toBe(false);
    expect(store.setProjectTrusted(project, true).trusted).toBe(true);
    expect(new ResourceStore(userData).getTrustStatus(project).trusted).toBe(true);
    expect(store.setProjectTrusted(project, false).trusted).toBe(false);
  });

  it("detects project resources without reading their contents", () => {
    const userData = directory("pi-resource-user");
    const project = directory("pi-resource-project");
    fs.mkdirSync(path.join(project, ".git"));
    fs.mkdirSync(path.join(project, ".agents", "skills"), { recursive: true });
    fs.writeFileSync(path.join(project, "AGENTS.md"), "secret instructions");

    const status = new ResourceStore(userData).getTrustStatus(project);
    expect(status.hasProjectResources).toBe(true);
    expect(status.resourcePaths).toEqual(expect.arrayContaining([
      fs.realpathSync(path.join(project, ".agents", "skills")),
      fs.realpathSync(path.join(project, "AGENTS.md")),
    ]));
  });

  it("persists context and validated Skill settings", () => {
    const userData = directory("pi-resource-user");
    const store = new ResourceStore(userData);
    expect(store.getSettings()).toEqual({ workspaceContextEnabled: true, disabledSkills: [] });

    expect(store.saveSettings({
      workspaceContextEnabled: false,
      disabledSkills: ["code-review", "../../bad", "code-review"],
    })).toEqual({ workspaceContextEnabled: false, disabledSkills: ["code-review"] });
    expect(new ResourceStore(userData).getSettings()).toEqual({ workspaceContextEnabled: false, disabledSkills: ["code-review"] });
  });

  it("registers known workspaces and persists membership across instances", () => {
    const userData = directory("pi-resource-user");
    const workspace = directory("pi-resource-workspace");
    const other = directory("pi-resource-other");
    const store = new ResourceStore(userData);

    expect(store.isKnownWorkspace(workspace)).toBe(false);
    store.addKnownWorkspace(workspace);
    expect(store.isKnownWorkspace(workspace)).toBe(true);
    expect(new ResourceStore(userData).isKnownWorkspace(workspace)).toBe(true);
    expect(store.isKnownWorkspace(other)).toBe(false);
    expect(store.isKnownWorkspace(path.join(workspace, "nested"))).toBe(false);
  });

  it("persists isolated per-project Skill and MCP overrides", () => {
    const userData = directory("pi-resource-user");
    const first = directory("pi-resource-first");
    const second = directory("pi-resource-second");
    const store = new ResourceStore(userData);

    store.setProjectSkillEnabled(first, "code-review", false);
    store.setProjectMcpServerEnabled(first, "user:search", false);

    expect(store.isProjectSkillEnabled("code-review", first)).toBe(false);
    expect(store.isProjectMcpServerEnabled("user:search", first)).toBe(false);
    expect(store.isProjectSkillEnabled("code-review", second)).toBe(true);
    expect(store.isProjectMcpServerEnabled("user:search", second)).toBe(true);
    expect(new ResourceStore(userData).getProjectSettings(first)).toMatchObject({
      skillOverrides: { "code-review": false },
      mcpServerOverrides: { "user:search": false },
    });

    store.setProjectSkillEnabled(first, "code-review", true);
    store.setProjectMcpServerEnabled(first, "user:search", true);
    expect(store.getProjectSettings(first)).toMatchObject({ skillOverrides: {}, mcpServerOverrides: {} });
  });

  it("persists a strict project resource selection and restores global inheritance", () => {
    const userData = directory("pi-resource-selection-user");
    const workspace = directory("pi-resource-selection-project");
    const store = new ResourceStore(userData);

    store.setProjectSelection(workspace, {
      skills: ["code-review"],
      mcpServers: ["user:search"],
    });

    expect(new ResourceStore(userData).getProjectSettings(workspace)).toMatchObject({
      selectionMode: "custom",
      selectedSkills: ["code-review"],
      selectedMcpServers: ["user:search"],
    });
    expect(store.isProjectSkillEnabled("code-review", workspace)).toBe(true);
    expect(store.isProjectSkillEnabled("future-skill", workspace)).toBe(false);
    expect(store.isProjectMcpServerEnabled("user:search", workspace)).toBe(true);
    expect(store.isProjectMcpServerEnabled("user:future", workspace)).toBe(false);

    store.setProjectSelection(workspace);
    expect(store.getProjectSettings(workspace)).toMatchObject({ selectionMode: "inherit" });
    expect(store.isProjectSkillEnabled("future-skill", workspace)).toBe(true);
    expect(store.isProjectMcpServerEnabled("user:future", workspace)).toBe(true);
  });

  it("treats a symlinked workspace and its real target as equal", () => {
    const userData = directory("pi-resource-user");
    const target = directory("pi-resource-target");
    const link = path.join(directory("pi-resource-links"), "workspace-link");
    fs.symlinkSync(target, link, "dir");
    const store = new ResourceStore(userData);

    store.addKnownWorkspace(link);
    expect(store.isKnownWorkspace(link)).toBe(true);
    expect(store.isKnownWorkspace(target)).toBe(true);
    expect(store.isKnownWorkspace(fs.realpathSync(target))).toBe(true);
  });

  it("handles nonexistent workspaces without throwing", () => {
    const userData = directory("pi-resource-user");
    const missing = path.join(directory("pi-resource-parent"), "deleted");
    const store = new ResourceStore(userData);

    expect(store.isKnownWorkspace(missing)).toBe(false);
    store.addKnownWorkspace(missing);
    expect(store.isKnownWorkspace(missing)).toBe(true);
    expect(new ResourceStore(userData).isKnownWorkspace(missing)).toBe(true);
  });
});
