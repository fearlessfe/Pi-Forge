import type { ProjectResourceSettings } from "../src/contracts.js";
import type { RuntimeExecutionProfile } from "./agent-runtime-protocol.js";

type ConversationResourceSelection = Pick<RuntimeExecutionProfile, "resourceSelectionMode" | "selectedSkills" | "selectedMcpServers">;

/** Narrows project-authorized resources to a conversation's frozen selection. */
export function scopeProjectResources(
  project: ProjectResourceSettings,
  conversation: ConversationResourceSelection,
): ProjectResourceSettings {
  if (conversation.resourceSelectionMode !== "custom") return project;
  const projectAllowsSkill = (name: string) => project.selectionMode === "custom"
    ? project.selectedSkills.includes(name)
    : project.skillOverrides[name] !== false;
  const projectAllowsMcp = (key: string) => project.selectionMode === "custom"
    ? project.selectedMcpServers.includes(key)
    : project.mcpServerOverrides[key] !== false;
  return {
    ...project,
    selectionMode: "custom",
    selectedSkills: conversation.selectedSkills.filter(projectAllowsSkill),
    selectedMcpServers: conversation.selectedMcpServers.filter(projectAllowsMcp),
  };
}
