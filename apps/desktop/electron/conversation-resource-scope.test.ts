import { describe, expect, it } from "vitest";
import type { ProjectResourceSettings } from "../src/contracts.js";
import { scopeProjectResources } from "./conversation-resource-scope.js";

function project(overrides: Partial<ProjectResourceSettings> = {}): ProjectResourceSettings {
  return { cwd: "/workspace", selectionMode: "inherit", selectedSkills: [], selectedMcpServers: [], skillOverrides: {}, mcpServerOverrides: {}, ...overrides };
}

describe("scopeProjectResources", () => {
  it("keeps same-project conversation selections independent", () => {
    const base = project();
    expect(scopeProjectResources(base, { resourceSelectionMode: "custom", selectedSkills: ["review"], selectedMcpServers: ["user:docs"] }))
      .toMatchObject({ selectedSkills: ["review"], selectedMcpServers: ["user:docs"] });
    expect(scopeProjectResources(base, { resourceSelectionMode: "custom", selectedSkills: ["deploy"], selectedMcpServers: [] }))
      .toMatchObject({ selectedSkills: ["deploy"], selectedMcpServers: [] });
  });

  it("cannot re-enable project-disabled resources", () => {
    const inherited = project({ skillOverrides: { deploy: false }, mcpServerOverrides: { "user:prod": false } });
    expect(scopeProjectResources(inherited, { resourceSelectionMode: "custom", selectedSkills: ["review", "deploy"], selectedMcpServers: ["user:docs", "user:prod"] }))
      .toMatchObject({ selectedSkills: ["review"], selectedMcpServers: ["user:docs"] });
    const custom = project({ selectionMode: "custom", selectedSkills: ["review"], selectedMcpServers: ["project:docs"] });
    expect(scopeProjectResources(custom, { resourceSelectionMode: "custom", selectedSkills: ["review", "deploy"], selectedMcpServers: ["project:docs", "user:prod"] }))
      .toMatchObject({ selectedSkills: ["review"], selectedMcpServers: ["project:docs"] });
  });

  it("treats an empty custom selection as no conversation resources", () => {
    expect(scopeProjectResources(project(), { resourceSelectionMode: "custom", selectedSkills: [], selectedMcpServers: [] }))
      .toMatchObject({ selectionMode: "custom", selectedSkills: [], selectedMcpServers: [] });
  });

  it("preserves the project scope when the conversation inherits", () => {
    const base = project({ selectionMode: "custom", selectedSkills: ["review"], selectedMcpServers: ["project:docs"] });
    expect(scopeProjectResources(base, { resourceSelectionMode: "inherit", selectedSkills: ["ignored"], selectedMcpServers: [] })).toBe(base);
  });
});
