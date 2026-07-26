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
});
