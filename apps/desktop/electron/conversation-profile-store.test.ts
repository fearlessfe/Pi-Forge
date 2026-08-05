import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationProfileStore } from "./conversation-profile-store.js";

const directories: string[] = [];
const model = { provider: "openai", baseUrl: "https://api.example.test", modelId: "model-a", thinkingLevel: "high" as const };

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conversation-profile-"));
  directories.push(value);
  return value;
}

function project(cwd: string, skills: string[] = [], mcpServers: string[] = []) {
  return { cwd, selectionMode: "custom" as const, selectedSkills: skills, selectedMcpServers: mcpServers, skillOverrides: {}, mcpServerOverrides: {} };
}

afterEach(() => {
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("ConversationProfileStore", () => {
  it("migrates history without a profile to safe model and project defaults", () => {
    const root = directory();
    const cwd = path.join(root, "workspace");
    const store = new ConversationProfileStore(root);
    const profile = store.ensure("legacy-conversation", cwd, model, project(cwd, ["review"], ["project:trusted"]));

    expect(profile).toMatchObject({
      version: 1,
      conversationId: "legacy-conversation",
      provider: "openai",
      modelId: "model-a",
      cwd,
      resourceSelectionMode: "custom",
      selectedSkills: ["review"],
      selectedMcpServers: ["project:trusted"],
    });
    expect(new ConversationProfileStore(root).get("legacy-conversation")).toEqual(profile);
  });

  it("keeps profiles independent and drops malformed resource identifiers", () => {
    const root = directory();
    const store = new ConversationProfileStore(root);
    const cwd = path.join(root, "workspace");
    const a = store.ensure("a", cwd, model, project(cwd));
    store.ensure("b", cwd, { ...model, modelId: "model-b" }, project(cwd));
    store.save({ ...a, resourceSelectionMode: "custom", selectedSkills: ["review", "../escape"], selectedMcpServers: ["user:docs", "invalid"] });

    expect(store.get("a")).toMatchObject({ selectedSkills: ["review"], selectedMcpServers: ["user:docs"] });
    expect(store.get("b")).toMatchObject({ modelId: "model-b", selectedSkills: [], selectedMcpServers: [] });
  });

  it("falls back safely when the persisted file is corrupt", () => {
    const root = directory();
    fs.writeFileSync(path.join(root, "conversation-profiles.json"), "{broken", "utf8");
    expect(new ConversationProfileStore(root).get("missing")).toBeUndefined();
  });

  it("replaces a structurally present but unsafe legacy profile with defaults", () => {
    const root = directory();
    const cwd = path.join(root, "workspace");
    fs.writeFileSync(path.join(root, "conversation-profiles.json"), JSON.stringify({
      version: 1,
      profiles: { legacy: { version: 1, conversationId: "legacy", provider: "openai", baseUrl: "file:///tmp/key", modelId: "model", thinkingLevel: "unsafe", cwd: "../escape", resourceSelectionMode: "custom", selectedSkills: ["../escape"], selectedMcpServers: ["project:safe"], updatedAt: new Date().toISOString() } },
    }));
    expect(new ConversationProfileStore(root).ensure("legacy", cwd, model, project(cwd))).toMatchObject({
      provider: model.provider,
      thinkingLevel: model.thinkingLevel,
      cwd,
      selectedSkills: [],
    });
  });
});
