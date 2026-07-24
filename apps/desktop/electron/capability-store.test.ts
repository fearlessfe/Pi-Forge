import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityStore } from "./capability-store.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-capabilities-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("CapabilityStore", () => {
  it("defaults to the built-in subagent provider", () => {
    expect(new CapabilityStore(temporaryDirectory()).get()).toEqual({
      subagent: { kind: "builtin" },
      memory: { kind: "none" },
      learning: { kind: "none" },
      subagentHistory: [],
      memoryHistory: [],
      learningHistory: [],
    });
  });

  it("persists a validated plugin tool selection", () => {
    const directory = temporaryDirectory();
    const store = new CapabilityStore(directory);

    store.saveSubagent({ kind: "plugin", source: "npm:community-agents@1.2.0", toolName: "delegate_task" });

    expect(new CapabilityStore(directory).get()).toEqual({
      subagent: { kind: "plugin", source: "npm:community-agents@1.2.0", toolName: "delegate_task" },
      memory: { kind: "none" },
      learning: { kind: "none" },
      subagentHistory: [{ kind: "plugin", source: "npm:community-agents@1.2.0", toolName: "delegate_task" }],
      memoryHistory: [],
      learningHistory: [],
    });
    expect(fs.statSync(path.join(directory, "capabilities.json")).mode & 0o777).toBe(0o600);
  });

  it("falls back safely for malformed persisted settings", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "capabilities.json"), JSON.stringify({
      subagent: { kind: "plugin", toolName: "../../bad" },
    }));

    expect(new CapabilityStore(directory).get().subagent).toEqual({ kind: "builtin" });
  });

  it("keeps previous package providers available for switching back", () => {
    const store = new CapabilityStore(temporaryDirectory());
    store.savePackageCapability("memory", { kind: "plugin", source: "npm:pi-memory@0.4.0" });
    store.savePackageCapability("memory", { kind: "plugin", source: "npm:pi-hermes-memory@0.8.2" });

    const settings = store.savePackageCapability("memory", { kind: "plugin", source: "npm:pi-memory@0.4.0" });

    expect(settings.memory).toEqual({ kind: "plugin", source: "npm:pi-memory@0.4.0" });
    expect(settings.memoryHistory).toEqual([
      { kind: "plugin", source: "npm:pi-hermes-memory@0.8.2" },
      { kind: "plugin", source: "npm:pi-memory@0.4.0" },
    ]);
  });
});
