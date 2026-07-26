import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";

const cleanup: string[] = [];

function directory(name: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  cleanup.push(target);
  return target;
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("AgentService resource inventory", () => {
  it("reports Skills, prompts, Extension commands, sources, and disabled state", async () => {
    const cwd = directory("pi-inventory-project");
    const agentDir = directory("pi-inventory-agent");
    fs.mkdirSync(path.join(agentDir, "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "skills", "review", "SKILL.md"), `---\nname: review\ndescription: Review code carefully.\n---\n# Review\n`);
    fs.mkdirSync(path.join(agentDir, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "prompts", "summarize.md"), `---\ndescription: Summarize the selected text.\n---\nSummarize $ARGUMENTS`);
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "extensions", "status.js"), `export default function (pi) { pi.registerCommand("status", { description: "Show status", handler: async () => {} }); }`);

    const resources = {
      getSettings: () => ({ workspaceContextEnabled: true, disabledSkills: ["review"] }),
      isProjectTrusted: () => false,
      getTrustStatus: (projectPath: string) => ({ path: projectPath, trusted: false, hasProjectResources: false, resourcePaths: [] }),
    };
    const service = new AgentService({ resolve: () => ({}) as never }, agentDir, cwd, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, resources);
    const inventory = await service.getResourceInventory(cwd);

    expect(inventory.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: "review", enabled: false, scope: "user" })]));
    expect(inventory.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "/summarize", source: "prompt" }),
      expect.objectContaining({ name: "/status", source: "extension" }),
    ]));
    expect(inventory.commands.some((command) => command.name === "/skill:review")).toBe(false);
  });

  it("does not discover project resources until the project is trusted", async () => {
    const cwd = directory("pi-untrusted-project");
    const agentDir = directory("pi-untrusted-agent");
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.mkdirSync(path.join(cwd, ".agents", "skills", "project-review"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".agents", "skills", "project-review", "SKILL.md"), `---\nname: project-review\ndescription: Review this project.\n---\n# Project review\n`);
    let trusted = false;
    const resources = {
      getSettings: () => ({ workspaceContextEnabled: true, disabledSkills: [] as string[] }),
      isProjectTrusted: () => trusted,
      getTrustStatus: (projectPath: string) => ({ path: projectPath, trusted, hasProjectResources: true, resourcePaths: [path.join(cwd, ".agents", "skills")] }),
    };
    const service = new AgentService({ resolve: () => ({}) as never }, agentDir, cwd, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, resources);

    expect((await service.getResourceInventory(cwd)).skills.some((skill) => skill.name === "project-review")).toBe(false);
    trusted = true;
    expect((await service.getResourceInventory(cwd)).skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "project-review", scope: "project" }),
    ]));
  });
});
