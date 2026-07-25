import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maxSystemPromptLength, SystemPromptStore } from "./system-prompt-store.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-prompt-store-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SystemPromptStore", () => {
  it("persists the appended system prompt in the Pi resource file", () => {
    const agentDir = temporaryDirectory();
    const store = new SystemPromptStore(agentDir);

    expect(store.get()).toEqual({ content: "" });
    expect(store.save({ content: "  Always answer concisely.\n" })).toEqual({ content: "Always answer concisely." });
    expect(fs.readFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "utf8")).toBe("Always answer concisely.");
    expect(new SystemPromptStore(agentDir).get()).toEqual({ content: "Always answer concisely." });
  });

  it("restores the default prompt by removing an empty override", () => {
    const agentDir = temporaryDirectory();
    const store = new SystemPromptStore(agentDir);
    store.save({ content: "Use Chinese." });

    expect(store.save({ content: "   " })).toEqual({ content: "" });
    expect(fs.existsSync(path.join(agentDir, "APPEND_SYSTEM.md"))).toBe(false);
  });

  it("rejects prompts that are too large", () => {
    const store = new SystemPromptStore(temporaryDirectory());
    expect(() => store.save({ content: "x".repeat(maxSystemPromptLength + 1) })).toThrow("系统提示词不能超过");
  });
});
