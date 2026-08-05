import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createDesktopResourceLoader } from "./resource-loader-factory.js";

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
      getSettings: () => ({ workspaceContextEnabled: true, disabledSkills: [] as string[] }),
      getProjectSettings: (projectPath: string) => ({ cwd: projectPath, selectionMode: "inherit" as const, selectedSkills: [], selectedMcpServers: [], skillOverrides: { review: false }, mcpServerOverrides: {} }),
      isProjectTrusted: () => false,
      getTrustStatus: (projectPath: string) => ({ path: projectPath, trusted: false, hasProjectResources: false, resourcePaths: [] }),
    };
    const service = new AgentService({ resolve: () => ({}) as never }, agentDir, cwd, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, resources);
    const inventory = await service.getResourceInventory(cwd);

    expect(inventory.skills).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "review",
      enabled: false,
      globalEnabled: true,
      projectEnabled: false,
      scope: "user",
    })]));
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

  it("does not let a conversation/project selection re-enable a globally disabled Skill", async () => {
    const cwd = directory("pi-global-disabled-project");
    const agentDir = directory("pi-global-disabled-agent");
    fs.mkdirSync(path.join(agentDir, "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code.\n---\n# Review\n");
    const resources = {
      getSettings: () => ({ workspaceContextEnabled: true, disabledSkills: ["review"] }),
      getProjectSettings: (projectPath: string) => ({ cwd: projectPath, selectionMode: "custom" as const, selectedSkills: ["review"], selectedMcpServers: [], skillOverrides: {}, mcpServerOverrides: {} }),
      isProjectTrusted: () => false,
      getTrustStatus: (projectPath: string) => ({ path: projectPath, trusted: false, hasProjectResources: false, resourcePaths: [] }),
    };
    const service = new AgentService({ resolve: () => ({}) as never }, agentDir, cwd, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, resources);

    const inventory = await service.getResourceInventory(cwd);

    expect(inventory.skills).toContainEqual(expect.objectContaining({ name: "review", globalEnabled: false, projectEnabled: true, enabled: false }));
    expect(inventory.commands.some((command) => command.name === "/skill:review")).toBe(false);
  });

  it("enables only explicitly selected Skills in a custom project profile", async () => {
    const cwd = directory("pi-selection-project");
    const agentDir = directory("pi-selection-agent");
    for (const name of ["review", "release"]) {
      fs.mkdirSync(path.join(agentDir, "skills", name), { recursive: true });
      fs.writeFileSync(path.join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} helper.\n---\n# ${name}\n`);
    }
    const resources = {
      getSettings: () => ({ workspaceContextEnabled: true, disabledSkills: [] as string[] }),
      getProjectSettings: (projectPath: string) => ({
        cwd: projectPath,
        selectionMode: "custom" as const,
        selectedSkills: ["review"],
        selectedMcpServers: [],
        skillOverrides: {},
        mcpServerOverrides: {},
      }),
      isProjectTrusted: () => false,
      getTrustStatus: (projectPath: string) => ({ path: projectPath, trusted: false, hasProjectResources: false, resourcePaths: [] }),
    };
    const service = new AgentService({ resolve: () => ({}) as never }, agentDir, cwd, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, resources);
    const inventory = await service.getResourceInventory(cwd);

    expect(inventory.projectSettings.selectionMode).toBe("custom");
    expect(inventory.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "review", enabled: true, projectEnabled: true }),
      expect.objectContaining({ name: "release", enabled: false, projectEnabled: false }),
    ]));
    expect(inventory.commands.some((command) => command.name === "/skill:review")).toBe(true);
    expect(inventory.commands.some((command) => command.name === "/skill:release")).toBe(false);

    const runtimeLoader = createDesktopResourceLoader({
      cwd,
      agentDir,
      projectContextEnabled: false,
      enabledSkills: ["review"],
      filterExtensions: (base) => base,
      isPluginSourceEnabled: () => true,
    });
    await runtimeLoader.reload();
    expect(runtimeLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["review"]);
  });

  it("builds a content-safe budget from the runtime resource assembly path", async () => {
    const cwd = directory("pi-budget-project");
    const agentDir = directory("pi-budget-agent");
    fs.mkdirSync(path.join(cwd, ".git"));
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "Project instructions for the agent.");
    fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "Use concise answers.");
    fs.mkdirSync(path.join(agentDir, "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code carefully.\n---\n# Private review instructions\n");
    fs.mkdirSync(path.join(agentDir, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "prompts", "summarize.md"), "---\ndescription: Summarize text.\n---\nSummarize $ARGUMENTS");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "extensions", "status.js"), "export default function (pi) { pi.registerCommand('status', { description: 'Show status', handler: async () => {} }); }");

    const resources = {
      getSettings: () => ({ workspaceContextEnabled: true, disabledSkills: [] as string[] }),
      getProjectSettings: (projectPath: string) => ({ cwd: projectPath, selectionMode: "inherit" as const, selectedSkills: [], selectedMcpServers: [], skillOverrides: { review: false }, mcpServerOverrides: {} }),
      isProjectTrusted: () => true,
      getTrustStatus: (projectPath: string) => ({ path: projectPath, trusted: true, hasProjectResources: true, resourcePaths: [path.join(cwd, "AGENTS.md")] }),
    };
    const mcp = {
      tools: async () => [],
      contextInventory: async () => [{
        key: "user:search",
        name: "Search MCP",
        scope: "user" as const,
        enabled: true,
        schemaAvailable: true,
        tools: [{
          serverKey: "user:search",
          name: "mcp__search__query",
          remoteName: "query",
          description: "Search documents",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        }],
      }],
      callTool: async () => ({ text: "", details: undefined }),
    };
    const service = new AgentService({
      resolve: () => ({
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "gpt-5",
        thinkingLevel: "off",
        apiKey: "local-test-key",
      }),
    }, agentDir, cwd, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, resources, mcp);
    const report = await service.getContextBudget(cwd);

    expect(report.totalEstimatedTokens).toBeGreaterThan(0);
    expect(report.baselineEstimatedTokens).toBeGreaterThan(0);
    expect(report.systemPromptEstimatedTokens).toBeGreaterThan(0);
    expect(report.toolSchemaEstimatedTokens).toBeGreaterThan(0);
    expect(report.activeToolCount).toBeGreaterThan(0);
    expect(report.resourceBaselineEstimatedTokens).toBeGreaterThan(0);
    expect(report.onDemandEstimatedTokens).toBeGreaterThan(0);
    expect(report.groups.map((group) => group.category)).toEqual([
      "systemPrompt", "agents", "skills", "prompts", "extensions", "mcpSchemas",
    ]);
    expect(report.groups.find((group) => group.category === "skills")?.items.find((item) => item.name === "review")).toMatchObject({
      name: "review",
      enabled: false,
      disableSupported: true,
      loadMode: "mixed",
    });
    expect(report.groups.find((group) => group.category === "mcpSchemas")?.items[0]).toMatchObject({
      name: "Search MCP",
      enabled: true,
      estimateStatus: "estimated",
    });
    expect(JSON.stringify(report)).not.toContain("Private review instructions");
    expect(JSON.stringify(report)).not.toContain("properties");
  });
});
