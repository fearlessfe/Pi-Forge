import fs from "node:fs";
import path from "node:path";
import type {
  ConversationExecutionProfile,
  ProjectResourceSettings,
  SaveConversationExecutionProfile,
  SaveModelSettings,
} from "../src/contracts.js";

type StoredProfiles = { version: 1; profiles: Record<string, ConversationExecutionProfile> };

const conversationIdPattern = /^[^\0\r\n]{1,256}$/;
const skillPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const mcpPattern = /^(?:user|project):[^\0\r\n]{1,2048}$/;
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function validBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function unique(value: unknown, valid: (entry: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(valid))];
}

function validProfile(value: unknown): value is ConversationExecutionProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return profile.version === 1
    && typeof profile.conversationId === "string" && conversationIdPattern.test(profile.conversationId)
    && typeof profile.provider === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(profile.provider)
    && validBaseUrl(profile.baseUrl)
    && typeof profile.modelId === "string" && Boolean(profile.modelId.trim())
    && typeof profile.thinkingLevel === "string" && thinkingLevels.has(profile.thinkingLevel)
    && typeof profile.cwd === "string" && path.isAbsolute(profile.cwd)
    && (profile.resourceSelectionMode === "inherit" || profile.resourceSelectionMode === "custom")
    && Array.isArray(profile.selectedSkills) && profile.selectedSkills.every((entry) => typeof entry === "string" && skillPattern.test(entry))
    && Array.isArray(profile.selectedMcpServers) && profile.selectedMcpServers.every((entry) => typeof entry === "string" && mcpPattern.test(entry))
    && typeof profile.updatedAt === "string";
}

/** Main-process-only persistence. It never stores API keys or other credentials. */
export class ConversationProfileStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "conversation-profiles.json");
  }

  get(conversationId: string): ConversationExecutionProfile | undefined {
    const profile = this.read().profiles[conversationId];
    return profile ? this.copy(profile) : undefined;
  }

  ensure(conversationId: string, cwd: string, model: SaveModelSettings, project: ProjectResourceSettings): ConversationExecutionProfile {
    const existing = this.get(conversationId);
    if (existing) return existing;
    return this.save({
      conversationId,
      provider: model.provider,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevel,
      cwd,
      resourceSelectionMode: project.selectionMode,
      selectedSkills: project.selectionMode === "custom" ? project.selectedSkills : [],
      selectedMcpServers: project.selectionMode === "custom" ? project.selectedMcpServers : [],
    });
  }

  save(input: SaveConversationExecutionProfile): ConversationExecutionProfile {
    if (!conversationIdPattern.test(input.conversationId)) throw new Error("会话 ID 无效。");
    const profile: ConversationExecutionProfile = {
      version: 1,
      conversationId: input.conversationId,
      provider: input.provider.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
      modelId: input.modelId.trim(),
      thinkingLevel: input.thinkingLevel,
      cwd: path.resolve(input.cwd),
      resourceSelectionMode: input.resourceSelectionMode,
      selectedSkills: unique(input.selectedSkills, (entry) => skillPattern.test(entry)),
      selectedMcpServers: unique(input.selectedMcpServers, (entry) => mcpPattern.test(entry)),
      updatedAt: new Date().toISOString(),
    };
    const stored = this.read();
    stored.profiles[input.conversationId] = profile;
    this.write(stored);
    return this.copy(profile);
  }

  delete(conversationId: string): void {
    const stored = this.read();
    if (!(conversationId in stored.profiles)) return;
    delete stored.profiles[conversationId];
    this.write(stored);
  }

  private copy(profile: ConversationExecutionProfile): ConversationExecutionProfile {
    return { ...profile, selectedSkills: [...profile.selectedSkills], selectedMcpServers: [...profile.selectedMcpServers] };
  }

  private read(): StoredProfiles {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, profiles: {} };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredProfiles>;
      if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") return { version: 1, profiles: {} };
      const profiles: Record<string, ConversationExecutionProfile> = {};
      for (const [id, value] of Object.entries(parsed.profiles)) if (validProfile(value) && value.conversationId === id) profiles[id] = this.copy(value);
      return { version: 1, profiles };
    } catch {
      return { version: 1, profiles: {} };
    }
  }

  private write(value: StoredProfiles): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
