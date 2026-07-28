import { describe, expect, it, vi } from "vitest";
import type { AgentSession, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { CapabilitySettings } from "../src/contracts.js";
import { CapabilityPolicy } from "./capability-policy.js";

function settings(overrides: Partial<CapabilitySettings> = {}): CapabilitySettings {
  return {
    subagent: { kind: "builtin" },
    memory: { kind: "none" },
    learning: { kind: "none" },
    subagentHistory: [],
    memoryHistory: [],
    learningHistory: [],
    ...overrides,
  };
}

type FakeSessionOptions = {
  activeTools?: string[];
  toolLabels?: Record<string, string>;
  registeredTools?: Array<{ name: string; source: string }>;
  tools?: Array<{ name: string; source: string; scope?: string; origin?: string }>;
  extensionSources?: string[];
};

function fakeSession(options: FakeSessionOptions = {}): AgentSession & { activeTools: string[] } {
  const state = {
    activeTools: [...(options.activeTools ?? ["read", "bash"])],
    setTools: [] as string[][],
  };
  const session = {
    get activeTools() {
      return state.activeTools;
    },
    getToolDefinition: (name: string) => {
      const label = options.toolLabels?.[name];
      return label ? { label } : undefined;
    },
    getActiveToolNames: () => state.activeTools,
    setActiveToolsByName: (names: string[]) => {
      state.setTools.push(names);
      state.activeTools = names;
    },
    extensionRunner: {
      getAllRegisteredTools: () => (options.registeredTools ?? []).map((tool) => ({
        definition: { name: tool.name },
        sourceInfo: { source: tool.source },
      })),
    },
    getAllTools: () => (options.tools ?? []).map((tool) => ({
      name: tool.name,
      description: `${tool.name} description`,
      sourceInfo: { source: tool.source, scope: tool.scope, origin: tool.origin },
    })),
    resourceLoader: {
      getExtensions: () => ({
        extensions: (options.extensionSources ?? []).map((source) => ({ sourceInfo: { source } })),
      }),
    },
  };
  return session as unknown as AgentSession & { activeTools: string[] };
}

function policy(
  capabilitySettings: CapabilitySettings,
  pluginSecurity?: { isEnabled(source: string, cwd?: string): boolean },
): CapabilityPolicy {
  return new CapabilityPolicy({ get: () => capabilitySettings }, pluginSecurity, "subagent");
}

describe("CapabilityPolicy", () => {
  it("activates the builtin subagent and detects the sandboxed bash label", () => {
    const session = fakeSession({ toolLabels: { bash: "bash (workspace sandbox)" } });
    const capabilityPolicy = policy(settings());
    capabilityPolicy.applyToolPolicy(session);

    expect(capabilityPolicy.sandboxedBashActive).toBe(true);
    expect(session.activeTools).toContain("subagent");
    expect(session.activeTools).toContain("read");
  });

  it("activates a plugin subagent tool when it resolves to the configured extension", () => {
    const capabilitySettings = settings({ subagent: { kind: "plugin", source: "npm:tools", toolName: "delegate" } });
    const session = fakeSession({
      registeredTools: [{ name: "delegate", source: "npm:tools" }],
      tools: [{ name: "delegate", source: "npm:tools" }],
    });
    const capabilityPolicy = policy(capabilitySettings);
    capabilityPolicy.applyToolPolicy(session);

    expect(session.activeTools).toContain("delegate");
    expect(session.activeTools).not.toContain("subagent");

    const runtime = capabilityPolicy.getPluginRuntime(session);
    expect(runtime.effectiveSubagent).toEqual({ kind: "plugin", source: "npm:tools", toolName: "delegate" });
    expect(runtime.fallbackReason).toBeUndefined();

    // Re-applying replaces the previously applied plugin tool.
    capabilityPolicy.applyToolPolicy(fakeSession({
      registeredTools: [{ name: "delegate", source: "npm:tools" }],
      tools: [{ name: "delegate", source: "npm:tools" }],
    }));
    const fresh = fakeSession();
    capabilityPolicy.applyToolPolicy(fresh);
    expect(fresh.activeTools).not.toContain("delegate");
  });

  it("falls back to the builtin subagent when the plugin tool is not registered", () => {
    const capabilitySettings = settings({ subagent: { kind: "plugin", source: "npm:tools", toolName: "delegate" } });
    const session = fakeSession();
    const capabilityPolicy = policy(capabilitySettings);
    capabilityPolicy.applyToolPolicy(session);

    expect(session.activeTools).toContain("subagent");
    const runtime = capabilityPolicy.getPluginRuntime(session);
    expect(runtime.effectiveSubagent).toEqual({ kind: "builtin" });
    expect(runtime.fallbackReason).toContain("delegate");
  });

  it("falls back when the tool name resolves to a non-extension source", () => {
    const capabilitySettings = settings({ subagent: { kind: "plugin", source: "npm:tools", toolName: "delegate" } });
    const session = fakeSession({
      registeredTools: [{ name: "delegate", source: "npm:tools" }],
      tools: [{ name: "delegate", source: "sdk" }],
    });
    const capabilityPolicy = policy(capabilitySettings);
    capabilityPolicy.applyToolPolicy(session);
    expect(session.activeTools).toContain("subagent");
  });

  it("reports pending runtime status without a session", () => {
    const capabilitySettings = settings({ memory: { kind: "plugin", source: "npm:memory" } });
    const runtime = policy(capabilitySettings).getPluginRuntime(undefined);
    expect(runtime).toMatchObject({
      hasSession: false,
      effectiveSubagent: { kind: "pending" },
      effectiveMemory: { kind: "pending" },
      effectiveLearning: { kind: "pending" },
      configuredMemory: { kind: "plugin", source: "npm:memory" },
      tools: [],
    });
  });

  it("classifies runtime tools and resolves memory/learning from loaded sources", () => {
    const capabilitySettings = settings({
      memory: { kind: "plugin", source: "npm:memory" },
      learning: { kind: "plugin", source: "npm:missing" },
    });
    const session = fakeSession({
      activeTools: ["read"],
      tools: [
        { name: "read", source: "builtin" },
        { name: "agent", source: "sdk" },
        { name: "proj-tool", source: "npm:x", scope: "project" },
        { name: "pkg-tool", source: "npm:y", origin: "package" },
        { name: "other-tool", source: "npm:z" },
      ],
      extensionSources: ["npm:memory"],
    });
    const runtime = policy(capabilitySettings).getPluginRuntime(session);

    expect(runtime.hasSession).toBe(true);
    expect(runtime.effectiveMemory).toEqual({ kind: "plugin", source: "npm:memory" });
    expect(runtime.effectiveLearning).toEqual({ kind: "none" });
    expect(runtime.tools).toEqual([
      { name: "read", description: "read description", active: true, source: "builtin", sourceKind: "builtin" },
      { name: "agent", description: "agent description", active: false, source: "sdk", sourceKind: "desktop" },
      { name: "proj-tool", description: "proj-tool description", active: false, source: "npm:x", sourceKind: "project" },
      { name: "pkg-tool", description: "pkg-tool description", active: false, source: "npm:y", sourceKind: "package" },
      { name: "other-tool", description: "other-tool description", active: false, source: "npm:z", sourceKind: "other" },
    ]);

    const loadedLearning = policy(settings({ learning: { kind: "plugin", source: "npm:memory" } }));
    expect(loadedLearning.getPluginRuntime(session).effectiveLearning).toEqual({ kind: "plugin", source: "npm:memory" });
  });

  it("filters historical and disabled plugin sources from loaded extensions", () => {
    const capabilitySettings = settings({
      subagent: { kind: "plugin", source: "npm:active", toolName: "delegate" },
      memory: { kind: "plugin", source: "npm:mem-active" },
      learning: { kind: "plugin", source: "npm:learn-active" },
      subagentHistory: [{ kind: "builtin" }, { kind: "plugin", source: "npm:sub-old", toolName: "legacy" }],
      memoryHistory: [{ kind: "plugin", source: "npm:old" }, { kind: "none" }],
      learningHistory: [{ kind: "plugin", source: "npm:active" }],
    });
    const base = {
      extensions: ["npm:active", "npm:mem-active", "npm:learn-active", "npm:sub-old", "npm:old", "npm:blocked", "npm:allowed", "path:local"].map((source) => ({
        sourceInfo: { source },
      })),
      errors: [],
    } as unknown as LoadExtensionsResult;
    const pluginSecurity = { isEnabled: (source: string) => source !== "npm:blocked" };

    const filtered = policy(capabilitySettings, pluginSecurity).filterCapabilityExtensions(base, "/workspace");
    const sources = filtered.extensions.map((extension) => extension.sourceInfo.source);
    expect(sources).toEqual(["npm:active", "npm:mem-active", "npm:learn-active", "npm:allowed", "path:local"]);
  });

  it("keeps npm extensions when no plugin security reader is configured", () => {
    const base = {
      extensions: [{ sourceInfo: { source: "npm:any" } }],
    } as unknown as LoadExtensionsResult;
    const filtered = policy(settings()).filterCapabilityExtensions(base);
    expect(filtered.extensions).toHaveLength(1);
    expect(policy(settings()).isPluginSourceEnabled("npm:any", "/workspace")).toBe(true);
  });

  it("delegates npm gating to plugin security and passes the cwd through", () => {
    const isEnabled = vi.fn(() => false);
    const capabilityPolicy = policy(settings(), { isEnabled });
    expect(capabilityPolicy.isPluginSourceEnabled("npm:pkg", "/workspace")).toBe(false);
    expect(isEnabled).toHaveBeenCalledWith("npm:pkg", "/workspace");
    expect(capabilityPolicy.isPluginSourceEnabled("path:local")).toBe(true);
  });
});
