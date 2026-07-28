import type { AgentSession, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { CapabilitySettings, PluginRuntimeStatus, RuntimeTool } from "../src/contracts.js";

type CapabilitySettingsReader = Pick<{ get(): CapabilitySettings }, "get">;
type PluginSecurityReader = Pick<{ isEnabled(source: string, cwd?: string): boolean }, "isEnabled">;

export class CapabilityPolicy {
  sandboxedBashActive = false;
  private appliedSubagentTool?: string;
  private capabilityFallbackReason?: string;

  constructor(
    private readonly capabilities: CapabilitySettingsReader,
    private readonly pluginSecurity: PluginSecurityReader | undefined,
    private readonly builtinSubagentToolName: string,
  ) {}

  applyToolPolicy(session: AgentSession): void {
    this.sandboxedBashActive = session.getToolDefinition("bash")?.label === "bash (workspace sandbox)";
    const activeTools = new Set(session.getActiveToolNames());
    for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user"]) {
      if (session.getToolDefinition(name)) activeTools.add(name);
    }
    if (this.appliedSubagentTool) activeTools.delete(this.appliedSubagentTool);
    activeTools.delete(this.builtinSubagentToolName);
    this.capabilityFallbackReason = undefined;

    const configured = this.capabilities.get().subagent;
    if (configured.kind === "plugin") {
      const extensionTool = session.extensionRunner.getAllRegisteredTools()
        .find((tool) => tool.definition.name === configured.toolName && tool.sourceInfo.source === configured.source);
      const resolvedTool = session.getAllTools().find((tool) => tool.name === configured.toolName);
      const resolvesToExtension = resolvedTool
        && resolvedTool.sourceInfo.source !== "sdk"
        && resolvedTool.sourceInfo.source !== "builtin"
        && resolvedTool.sourceInfo.source === configured.source;
      if (extensionTool && resolvesToExtension && configured.toolName !== this.builtinSubagentToolName) {
        activeTools.add(configured.toolName);
        this.appliedSubagentTool = configured.toolName;
      } else {
        activeTools.add(this.builtinSubagentToolName);
        this.appliedSubagentTool = this.builtinSubagentToolName;
        this.capabilityFallbackReason = `${configured.source} 的工具 ${configured.toolName} 未成功注册，已回退到内置 Subagent。`;
      }
    } else {
      activeTools.add(this.builtinSubagentToolName);
      this.appliedSubagentTool = this.builtinSubagentToolName;
    }
    session.setActiveToolsByName([...activeTools]);
  }

  getPluginRuntime(session: AgentSession | undefined): PluginRuntimeStatus {
    const capabilitySettings = this.capabilities.get();
    const configuredSubagent = capabilitySettings.subagent;
    if (!session) {
      return {
        hasSession: false,
        configuredSubagent,
        effectiveSubagent: { kind: "pending" },
        configuredMemory: capabilitySettings.memory,
        effectiveMemory: { kind: "pending" },
        configuredLearning: capabilitySettings.learning,
        effectiveLearning: { kind: "pending" },
        subagentHistory: capabilitySettings.subagentHistory,
        memoryHistory: capabilitySettings.memoryHistory,
        learningHistory: capabilitySettings.learningHistory,
        tools: [],
      };
    }
    const tools = session.getAllTools().map((tool): RuntimeTool => {
      let sourceKind: RuntimeTool["sourceKind"] = "other";
      if (tool.sourceInfo.source === "builtin") sourceKind = "builtin";
      else if (tool.sourceInfo.source === "sdk") sourceKind = "desktop";
      else if (tool.sourceInfo.scope === "project") sourceKind = "project";
      else if (tool.sourceInfo.origin === "package") sourceKind = "package";
      return {
        name: tool.name,
        description: tool.description,
        active: session.getActiveToolNames().includes(tool.name),
        source: tool.sourceInfo.source,
        sourceKind,
      };
    });
    const pluginEffective = configuredSubagent.kind === "plugin"
      && this.appliedSubagentTool === configuredSubagent.toolName
      && !this.capabilityFallbackReason;
    const loadedSources = new Set(session.resourceLoader.getExtensions().extensions.map((extension) => extension.sourceInfo.source));
    const effectiveMemory = capabilitySettings.memory.kind === "plugin" && loadedSources.has(capabilitySettings.memory.source)
      ? capabilitySettings.memory
      : { kind: "none" as const };
    const effectiveLearning = capabilitySettings.learning.kind === "plugin" && loadedSources.has(capabilitySettings.learning.source)
      ? capabilitySettings.learning
      : { kind: "none" as const };
    return {
      hasSession: true,
      configuredSubagent,
      effectiveSubagent: pluginEffective ? configuredSubagent : { kind: "builtin" },
      configuredMemory: capabilitySettings.memory,
      effectiveMemory,
      configuredLearning: capabilitySettings.learning,
      effectiveLearning,
      subagentHistory: capabilitySettings.subagentHistory,
      memoryHistory: capabilitySettings.memoryHistory,
      learningHistory: capabilitySettings.learningHistory,
      fallbackReason: this.capabilityFallbackReason,
      tools,
    };
  }

  filterCapabilityExtensions(base: LoadExtensionsResult, cwd?: string): LoadExtensionsResult {
    const settings = this.capabilities.get();
    const activeSources = new Set<string>();
    if (settings.subagent.kind === "plugin") activeSources.add(settings.subagent.source);
    if (settings.memory.kind === "plugin") activeSources.add(settings.memory.source);
    if (settings.learning.kind === "plugin") activeSources.add(settings.learning.source);

    const historicalSources = new Set<string>();
    for (const provider of settings.subagentHistory) if (provider.kind === "plugin") historicalSources.add(provider.source);
    for (const provider of settings.memoryHistory) if (provider.kind === "plugin") historicalSources.add(provider.source);
    for (const provider of settings.learningHistory) if (provider.kind === "plugin") historicalSources.add(provider.source);
    for (const source of activeSources) historicalSources.delete(source);

    return {
      ...base,
      extensions: base.extensions.filter((extension) => (
        !historicalSources.has(extension.sourceInfo.source)
        && this.isPluginSourceEnabled(extension.sourceInfo.source, cwd)
      )),
    };
  }

  isPluginSourceEnabled(source: string, cwd?: string): boolean {
    return !source.startsWith("npm:") || !this.pluginSecurity || this.pluginSecurity.isEnabled(source, cwd);
  }
}
