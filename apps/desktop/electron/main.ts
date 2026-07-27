import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent, ModelMetadataOverride, PackageCapabilityProvider, PermissionSettings, ResourceSettings, SaveMcpServerInput, SaveModelSettings, SendPromptInput, SubagentProvider, SystemPromptSettings } from "../src/contracts.js";
import { AgentService } from "./agent-service.js";
import { AuthService } from "./auth-service.js";
import { CapabilityStore } from "./capability-store.js";
import { EncryptedCredentialStore } from "./credential-store.js";
import { PluginService } from "./plugin-service.js";
import { PluginSecurityStore } from "./plugin-security-store.js";
import { PermissionStore } from "./permission-store.js";
import { SettingsStore } from "./settings-store.js";
import { ModelMetadataStore } from "./model-metadata-store.js";
import { SystemPromptStore } from "./system-prompt-store.js";
import { ResourceStore } from "./resource-store.js";
import { McpStore } from "./mcp-store.js";
import { McpService } from "./mcp-service.js";
import { TerminalService } from "./terminal-service.js";
import { BrowserService } from "./browser-service.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let agentService: AgentService | undefined;
let authService: AuthService | undefined;
let pluginService: PluginService | undefined;
let mcpService: McpService | undefined;
let terminalService: TerminalService | undefined;
let browserService: BrowserService | undefined;

app.setName("Pi Forge");
app.setPath("userData", process.env.PI_DESKTOP_USER_DATA
  ? path.resolve(process.env.PI_DESKTOP_USER_DATA)
  : path.join(app.getPath("appData"), "Pi Desktop"));
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

function sendAgentEvent(event: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent:event", event);
}

function createWindow(): BrowserWindow {
  const rendererFile = path.join(currentDir, "../../dist/index.html");
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#090c11",
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed = devUrl ? url.startsWith(devUrl) : url === pathToFileURL(rendererFile).toString();
    if (!allowed) event.preventDefault();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(rendererFile);
  return window;
}

function requireSettings(value: unknown): SaveModelSettings {
  if (!value || typeof value !== "object") throw new Error("模型设置格式无效。");
  const input = value as Record<string, unknown>;
  if (
    typeof input.provider !== "string"
    || typeof input.baseUrl !== "string"
    || typeof input.modelId !== "string"
    || typeof input.thinkingLevel !== "string"
    || (input.apiKey !== undefined && typeof input.apiKey !== "string")
  ) throw new Error("模型设置字段无效。");
  return value as SaveModelSettings;
}

async function settingsWithCredentials(settings: SettingsStore, credentials: EncryptedCredentialStore) {
  const current = settings.get();
  const stored = [...await credentials.list()];
  return {
    ...current,
    hasApiKey: stored.some((credential) => credential.providerId === current.provider && credential.type === "api_key"),
    configuredProviders: stored.map((credential) => credential.providerId),
    credentials: stored,
  };
}

async function migrateLegacyApiKeys(settings: SettingsStore, credentials: EncryptedCredentialStore): Promise<void> {
  const legacy = settings.readLegacyApiKeys();
  for (const [providerId, key] of Object.entries(legacy)) {
    await credentials.modify(providerId, async (current) => current ?? { type: "api_key", key });
  }
  settings.clearLegacyApiKeys();
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function requirePermissionSettings(value: unknown): PermissionSettings {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).mode !== "string") {
    throw new Error("权限设置格式无效。");
  }
  return value as PermissionSettings;
}

function requireSystemPromptSettings(value: unknown): SystemPromptSettings {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).content !== "string") {
    throw new Error("系统提示词格式无效。");
  }
  return value as SystemPromptSettings;
}

function requireResourceSettings(value: unknown): ResourceSettings {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).workspaceContextEnabled !== "boolean") {
    throw new Error("资源设置格式无效。");
  }
  return value as ResourceSettings;
}

function requireMcpServerInput(value: unknown): SaveMcpServerInput {
  if (!value || typeof value !== "object") throw new Error("MCP Server 配置格式无效。");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.name !== "string" || typeof input.enabled !== "boolean" || typeof input.timeoutMs !== "number" || !input.transport || typeof input.transport !== "object") {
    throw new Error("MCP Server 配置字段无效。");
  }
  return value as SaveMcpServerInput;
}

function registerIpc(
  settings: SettingsStore,
  credentials: EncryptedCredentialStore,
  agent: AgentService,
  auth: AuthService,
  plugins: PluginService,
  capabilities: CapabilityStore,
  permissions: PermissionStore,
  systemPrompt: SystemPromptStore,
  modelMetadata: ModelMetadataStore,
  resources: ResourceStore,
  mcp: McpService,
  terminal: TerminalService,
  browser: BrowserService,
): void {
  ipcMain.handle("settings:get", () => settingsWithCredentials(settings, credentials));
  ipcMain.handle("settings:catalog", () => agent.getModelCatalog());
  ipcMain.handle("settings:refresh-metadata", () => agent.getModelCatalog(true));
  ipcMain.handle("settings:save-metadata", async (_event, providerId: unknown, modelId: unknown, value: unknown) => {
    modelMetadata.save(
      requireString(providerId, "模型提供商无效。"),
      requireString(modelId, "模型 ID 无效。"),
      value as ModelMetadataOverride,
    );
    agent.reset();
    return agent.getModelCatalog(false);
  });
  ipcMain.handle("settings:reset-metadata", async (_event, providerId: unknown, modelId: unknown) => {
    modelMetadata.reset(requireString(providerId, "模型提供商无效。"), requireString(modelId, "模型 ID 无效。"));
    agent.reset();
    return agent.getModelCatalog(false);
  });
  ipcMain.handle("settings:discover-models", (_event, value: unknown) => agent.discoverModels(requireSettings(value)));
  ipcMain.handle("settings:save", async (_event, value: unknown) => {
    agent.reset();
    const input = requireSettings(value);
    settings.save({ ...input, apiKey: undefined });
    if (input.apiKey?.trim()) {
      await credentials.modify(input.provider, async () => ({ type: "api_key", key: input.apiKey?.trim() }));
    }
    return settingsWithCredentials(settings, credentials);
  });
  ipcMain.handle("settings:test", async (_event, value: unknown) => {
    const response = await agent.testConfiguration(requireSettings(value));
    return { ok: true as const, response };
  });
  ipcMain.handle("permissions:get", () => agent.getPermissionRuntime());
  ipcMain.handle("permissions:save", (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改权限模式。");
    permissions.save(requirePermissionSettings(value));
    return agent.getPermissionRuntime();
  });
  ipcMain.handle("system-prompt:get", () => systemPrompt.get());
  ipcMain.handle("system-prompt:save", (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改系统提示词。");
    const saved = systemPrompt.save(requireSystemPromptSettings(value));
    agent.reset();
    return saved;
  });
  ipcMain.handle("auth:login", async (_event, providerId: unknown) => {
    agent.reset();
    return { loginId: await auth.login(requireString(providerId, "模型提供商无效。")) };
  });
  ipcMain.handle("auth:answer", (_event, requestId: unknown, value: unknown) => {
    auth.answer(requireString(requestId, "登录问题无效。"), typeof value === "string" ? value : "");
  });
  ipcMain.handle("auth:cancel", (_event, loginId: unknown) => {
    auth.cancel(requireString(loginId, "登录任务无效。"));
  });
  ipcMain.handle("auth:logout", async (_event, providerId: unknown) => {
    agent.reset();
    await auth.logout(requireString(providerId, "模型提供商无效。"));
  });
  ipcMain.handle("workspace:choose", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Agent 工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selectedPath = result.filePaths[0];
    return { name: path.basename(selectedPath), ...resources.getTrustStatus(selectedPath) };
  });
  ipcMain.handle("workspace:trust-status", (_event, value: unknown) => resources.getTrustStatus(requireString(value, "工作区路径无效。")));
  ipcMain.handle("workspace:set-trusted", (_event, value: unknown, trusted: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改项目信任状态。");
    if (typeof trusted !== "boolean") throw new Error("项目信任状态无效。");
    const status = resources.setProjectTrusted(requireString(value, "工作区路径无效。"), trusted);
    agent.reset();
    return status;
  });
  ipcMain.handle("resources:get-settings", () => resources.getSettings());
  ipcMain.handle("resources:save-settings", (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改资源设置。");
    const saved = resources.saveSettings(requireResourceSettings(value));
    agent.reset();
    return saved;
  });
  ipcMain.handle("resources:inventory", (_event, cwd: unknown) => agent.getResourceInventory(cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。")));
  ipcMain.handle("resources:set-skill-enabled", async (_event, name: unknown, enabled: unknown, cwd: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改 Skill。");
    const skillName = requireString(name, "Skill 名称无效。");
    if (typeof enabled !== "boolean") throw new Error("Skill 状态无效。");
    const current = resources.getSettings();
    const disabledSkills = enabled
      ? current.disabledSkills.filter((entry) => entry !== skillName)
      : [...new Set([...current.disabledSkills, skillName])];
    resources.saveSettings({ ...current, disabledSkills });
    agent.reset();
    return agent.getResourceInventory(cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。"));
  });
  ipcMain.handle("resources:execute-extension-command", async (_event, value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("命令格式无效。");
    const input = value as SendPromptInput;
    if (typeof input.prompt !== "string" || (input.cwd !== undefined && typeof input.cwd !== "string") || (input.conversationId !== undefined && typeof input.conversationId !== "string")) {
      throw new Error("命令字段无效。");
    }
    return { handled: await agent.executeExtensionCommand(input.prompt, input.cwd, input.conversationId) };
  });
  ipcMain.handle("mcp:overview", (_event, cwd: unknown) => mcp.overview(cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。")));
  ipcMain.handle("mcp:save", (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改 MCP 配置。");
    const overview = mcp.save(requireMcpServerInput(value));
    agent.reset();
    return overview;
  });
  ipcMain.handle("mcp:remove", async (_event, key: unknown, cwd: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再删除 MCP Server。");
    const overview = await mcp.remove(requireString(key, "MCP Server 无效。"), cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。"));
    agent.reset();
    return overview;
  });
  ipcMain.handle("mcp:connect", (_event, key: unknown, cwd: unknown) => mcp.connect(requireString(key, "MCP Server 无效。"), cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。")));
  ipcMain.handle("mcp:disconnect", (_event, key: unknown, cwd: unknown) => mcp.disconnect(requireString(key, "MCP Server 无效。"), cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。")));
  ipcMain.handle("mcp:reconnect", (_event, key: unknown, cwd: unknown) => mcp.reconnect(requireString(key, "MCP Server 无效。"), cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。")));
  ipcMain.handle("terminal:create", (_event, cwd: unknown, cols: unknown, rows: unknown) => terminal.create(
    cwd === undefined ? undefined : requireString(cwd, "终端工作目录无效。"),
    typeof cols === "number" ? cols : undefined,
    typeof rows === "number" ? rows : undefined,
  ));
  ipcMain.handle("terminal:list", () => terminal.list());
  ipcMain.handle("terminal:write", (_event, id: unknown, data: unknown) => terminal.write(requireString(id, "终端会话无效。"), typeof data === "string" ? data : ""));
  ipcMain.handle("terminal:resize", (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof cols !== "number" || typeof rows !== "number") throw new Error("终端尺寸无效。");
    terminal.resize(requireString(id, "终端会话无效。"), cols, rows);
  });
  ipcMain.handle("terminal:kill", (_event, id: unknown) => terminal.kill(requireString(id, "终端会话无效。")));
  ipcMain.handle("browser:state", () => browser.state());
  ipcMain.handle("browser:navigate", (_event, url: unknown) => browser.navigate(requireString(url, "浏览器地址无效。")));
  ipcMain.handle("browser:back", () => browser.back());
  ipcMain.handle("browser:forward", () => browser.forward());
  ipcMain.handle("browser:reload", () => browser.reload());
  ipcMain.handle("browser:stop", () => browser.stop());
  ipcMain.handle("browser:set-visible", (_event, visible: unknown) => {
    if (typeof visible !== "boolean") throw new Error("浏览器可见状态无效。");
    return browser.setVisible(visible);
  });
  ipcMain.handle("browser:set-bounds", (_event, value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("浏览器视图尺寸无效。");
    const bounds = value as Record<string, unknown>;
    if ([bounds.x, bounds.y, bounds.width, bounds.height].some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
      throw new Error("浏览器视图尺寸无效。");
    }
    browser.setBounds(bounds as { x: number; y: number; width: number; height: number });
  });
  ipcMain.handle("browser:start-annotation", (_event, prompt: unknown) => browser.startAnnotation(
    undefined,
    typeof prompt === "string" ? prompt : "",
  ));
  ipcMain.handle("browser:cancel-annotation", () => browser.cancelAnnotation());
  ipcMain.handle("plugins:search", (_event, query: unknown, offset: unknown) => {
    return plugins.search(typeof query === "string" ? query : "", typeof offset === "number" ? offset : 0);
  });
  ipcMain.handle("plugins:details", (_event, name: unknown, version: unknown) => {
    return plugins.details(
      requireString(name, "插件包名无效。"),
      version === undefined ? undefined : requireString(version, "插件版本无效。"),
    );
  });
  ipcMain.handle("plugins:list", (_event, cwd: unknown) => plugins.listInstalled(cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。")));
  ipcMain.handle("plugins:install", async (_event, name: unknown, version: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再安装插件。");
    const installed = await plugins.install(
      requireString(name, "插件包名无效。"),
      requireString(version, "插件版本无效。"),
    );
    const reloaded = await agent.reloadPackages();
    return { installed, reloaded, runtime: agent.getPluginRuntime() };
  });
  ipcMain.handle("plugins:remove", async (_event, source: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再卸载插件。");
    const packageSource = requireString(source, "插件安装来源无效。");
    const currentCapabilities = capabilities.get();
    if (currentCapabilities.subagent.kind === "plugin" && currentCapabilities.subagent.source === packageSource) {
      capabilities.saveSubagent({ kind: "builtin" });
    }
    if (currentCapabilities.memory.kind === "plugin" && currentCapabilities.memory.source === packageSource) {
      capabilities.savePackageCapability("memory", { kind: "none" });
    }
    if (currentCapabilities.learning.kind === "plugin" && currentCapabilities.learning.source === packageSource) {
      capabilities.savePackageCapability("learning", { kind: "none" });
    }
    const installed = await plugins.remove(packageSource);
    const reloaded = await agent.reloadPackages();
    return { installed, reloaded, runtime: agent.getPluginRuntime() };
  });
  ipcMain.handle("plugins:reload", async () => {
    const reloaded = await agent.reloadPackages();
    return { reloaded, runtime: agent.getPluginRuntime() };
  });
  ipcMain.handle("plugins:set-enabled", async (_event, source: unknown, enabled: unknown, cwd: unknown, scope: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再切换插件状态。");
    if (typeof enabled !== "boolean") throw new Error("插件启停状态无效。");
    if (scope !== undefined && scope !== "user" && scope !== "project") throw new Error("插件启停范围无效。");
    const packageSource = requireString(source, "插件安装来源无效。");
    const projectPath = cwd === undefined ? undefined : requireString(cwd, "工作区路径无效。");
    const installed = plugins.setEnabled(packageSource, enabled, projectPath, scope === "project" ? "project" : "user");
    if (!enabled) {
      const currentCapabilities = capabilities.get();
      if (currentCapabilities.subagent.kind === "plugin" && currentCapabilities.subagent.source === packageSource) capabilities.saveSubagent({ kind: "builtin" });
      if (currentCapabilities.memory.kind === "plugin" && currentCapabilities.memory.source === packageSource) capabilities.savePackageCapability("memory", { kind: "none" });
      if (currentCapabilities.learning.kind === "plugin" && currentCapabilities.learning.source === packageSource) capabilities.savePackageCapability("learning", { kind: "none" });
    }
    const reloaded = await agent.reloadPackages();
    return { installed, reloaded, runtime: agent.getPluginRuntime() };
  });
  ipcMain.handle("plugins:runtime", () => agent.getPluginRuntime());
  ipcMain.handle("plugins:set-subagent-provider", (_event, value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Subagent 能力配置无效。");
    const input = value as Record<string, unknown>;
    let provider: SubagentProvider;
    if (input.kind === "builtin") provider = { kind: "builtin" };
    else if (input.kind === "plugin" && typeof input.source === "string" && typeof input.toolName === "string") {
      provider = { kind: "plugin", source: input.source, toolName: input.toolName };
    } else throw new Error("Subagent 能力配置无效。");
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再切换能力提供者。");
    if (provider.kind === "plugin" && !agent.getPluginRuntime().hasSession) {
      throw new Error("请先创建一次 Agent 会话，再 Reload 并选择实际加载的第三方工具。");
    }
    const previous = capabilities.get().subagent;
    capabilities.saveSubagent(provider);
    return agent.reloadPackages().then(async (reloaded) => {
      const status = agent.getPluginRuntime();
      if (!reloaded || provider.kind !== "plugin") return status;
      const matches = status.effectiveSubagent.kind === "plugin"
        && status.effectiveSubagent.source === provider.source
        && status.effectiveSubagent.toolName === provider.toolName;
      if (matches) return status;
      const reason = status.fallbackReason ?? `${provider.source} 没有成功提供 ${provider.toolName}。`;
      capabilities.saveSubagent(previous);
      await agent.reloadPackages();
      return { ...agent.getPluginRuntime(), fallbackReason: `${reason} 已恢复上一个 Subagent 提供者。` };
    });
  });
  ipcMain.handle("plugins:set-package-capability", async (_event, slotValue: unknown, value: unknown) => {
    if (slotValue !== "memory" && slotValue !== "learning") throw new Error("能力槽无效。");
    if (!value || typeof value !== "object") throw new Error("能力提供者配置无效。");
    const input = value as Record<string, unknown>;
    let provider: PackageCapabilityProvider;
    if (input.kind === "none") provider = { kind: "none" };
    else if (input.kind === "plugin" && typeof input.source === "string") provider = { kind: "plugin", source: input.source };
    else throw new Error("能力提供者配置无效。");
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再切换能力提供者。");
    if (provider.kind === "plugin" && !agent.getPluginRuntime().hasSession) {
      throw new Error("请先创建一次 Agent 会话，再 Reload 并验证该插件后切换能力提供者。");
    }
    const previous = capabilities.get()[slotValue];
    capabilities.savePackageCapability(slotValue, provider);
    const reloaded = await agent.reloadPackages();
    const status = agent.getPluginRuntime();
    const effective = slotValue === "memory" ? status.effectiveMemory : status.effectiveLearning;
    if (!reloaded || provider.kind !== "plugin") return status;
    const matches = effective.kind === "plugin" && effective.source === provider.source;
    if (matches) return status;
    capabilities.savePackageCapability(slotValue, previous);
    await agent.reloadPackages();
    return {
      ...agent.getPluginRuntime(),
      fallbackReason: `${provider.source} 没有成功加载，已恢复上一个${slotValue === "memory" ? "记忆" : "自学习"}提供者。`,
    };
  });
  ipcMain.handle("agent:send", async (_event, value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("消息格式无效。");
    const input = value as SendPromptInput;
    if (
      typeof input.prompt !== "string"
      || (input.cwd !== undefined && typeof input.cwd !== "string")
      || (input.conversationId !== undefined && typeof input.conversationId !== "string")
    ) {
      throw new Error("消息字段无效。");
    }
    const runId = await agent.send(input.prompt, input.cwd, input.conversationId);
    return { runId };
  });
  ipcMain.handle("agent:list-conversations", () => agent.listConversations());
  ipcMain.handle("agent:load-conversation", (_event, conversationId: unknown) => agent.loadConversation(requireString(conversationId, "会话 ID 无效。")));
  ipcMain.handle("agent:rename-conversation", (_event, conversationId: unknown, title: unknown) => (
    agent.renameConversation(requireString(conversationId, "会话 ID 无效。"), requireString(title, "会话名称无效。"))
  ));
  ipcMain.handle("agent:fork-conversation", (_event, conversationId: unknown, entryId: unknown) => agent.forkConversation(
    requireString(conversationId, "会话 ID 无效。"),
    entryId === undefined ? undefined : requireString(entryId, "会话节点无效。"),
  ));
  ipcMain.handle("agent:export-conversation", (_event, conversationId: unknown, format: unknown) => {
    if (format !== "markdown" && format !== "json") throw new Error("会话导出格式无效。");
    return agent.exportConversation(requireString(conversationId, "会话 ID 无效。"), format);
  });
  ipcMain.handle("agent:set-conversation-archived", (_event, conversationId: unknown, archived: unknown) => {
    if (typeof archived !== "boolean") throw new Error("会话归档状态无效。");
    return agent.setConversationArchived(requireString(conversationId, "会话 ID 无效。"), archived);
  });
  ipcMain.handle("agent:set-conversation-tags", (_event, conversationId: unknown, tags: unknown) => {
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new Error("会话标签无效。");
    return agent.setConversationTags(requireString(conversationId, "会话 ID 无效。"), tags as string[]);
  });
  ipcMain.handle("agent:delete-conversation", (_event, conversationId: unknown) => (
    agent.deleteConversation(requireString(conversationId, "会话 ID 无效。"))
  ));
  ipcMain.handle("agent:abort", () => agent.abort());
  ipcMain.handle("agent:queue", (_event, prompt: unknown, mode: unknown) => {
    if (mode !== "steer" && mode !== "followUp") throw new Error("消息排队模式无效。");
    return agent.queueMessage(requireString(prompt, "排队消息无效。"), mode);
  });
  ipcMain.handle("agent:clear-queue", () => agent.clearQueue());
  ipcMain.handle("agent:list-changes", (_event, runId: unknown) => agent.listChanges(runId === undefined ? undefined : requireString(runId, "任务 ID 无效。")));
  ipcMain.handle("agent:accept-changes", (_event, changeIds: unknown) => {
    if (changeIds !== undefined && (!Array.isArray(changeIds) || changeIds.some((entry) => typeof entry !== "string"))) throw new Error("文件变更 ID 无效。");
    return agent.acceptChanges(changeIds as string[] | undefined);
  });
  ipcMain.handle("agent:revert-changes", (_event, changeIds: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再回退文件变更。");
    if (changeIds !== undefined && (!Array.isArray(changeIds) || changeIds.some((entry) => typeof entry !== "string"))) throw new Error("文件变更 ID 无效。");
    return agent.revertChanges(changeIds as string[] | undefined);
  });
  ipcMain.handle("agent:open-change", async (_event, changeId: unknown) => {
    const filePath = agent.changePath(requireString(changeId, "文件变更 ID 无效。"));
    const failure = await shell.openPath(filePath);
    if (failure) throw new Error(`无法打开文件：${failure}`);
  });
  ipcMain.handle("agent:reveal-change", (_event, changeId: unknown) => {
    shell.showItemInFolder(agent.changePath(requireString(changeId, "文件变更 ID 无效。")));
  });
  ipcMain.handle("agent:answer-question", (_event, callId: unknown, answer: unknown) => {
    if (typeof callId !== "string" || typeof answer !== "string") throw new Error("回答格式无效。");
    agent.answerQuestion(callId, answer);
  });
  ipcMain.handle("agent:reset", () => agent.reset());
}

if (isPrimaryInstance) void app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const piDesktopHome = path.join(os.homedir(), ".pi-desktop");
  const chatSandbox = path.join(piDesktopHome, "workspace");
  const settings = new SettingsStore(userData);
  const capabilities = new CapabilityStore(userData);
  const permissions = new PermissionStore(userData);
  const credentials = new EncryptedCredentialStore(userData);
  const modelMetadata = new ModelMetadataStore(userData);
  const resources = new ResourceStore(userData);
  const pluginSecurity = new PluginSecurityStore(userData);
  const mcpStore = new McpStore(userData);
  mcpService = new McpService(mcpStore, resources);
  terminalService = new TerminalService(chatSandbox, (event) => mainWindow?.webContents.send("terminal:event", event));
  browserService = new BrowserService(
    () => mainWindow,
    path.join(app.getPath("temp"), "pi-desktop-browser"),
    (event) => mainWindow?.webContents.send("browser:event", event),
  );
  const systemPrompt = new SystemPromptStore(path.join(userData, "pi-agent"));
  try {
    await migrateLegacyApiKeys(settings, credentials);
  } catch (error) {
    console.error("Credential migration failed:", error instanceof Error ? error.message : String(error));
  }
  agentService = new AgentService(
    settings,
    path.join(userData, "pi-agent"),
    chatSandbox,
    sendAgentEvent,
    credentials,
    capabilities,
    path.join(piDesktopHome, "sessions"),
    permissions,
    undefined,
    modelMetadata,
    resources,
    mcpService,
    pluginSecurity,
    browserService,
  );
  authService = new AuthService(
    credentials,
    path.join(userData, "pi-agent"),
    (event) => mainWindow?.webContents.send("auth:event", event),
    (url) => shell.openExternal(url),
  );
  pluginService = new PluginService(
    path.join(userData, "pi-agent"),
    chatSandbox,
    (event) => mainWindow?.webContents.send("plugins:event", event),
    { securityStore: pluginSecurity },
  );
  registerIpc(settings, credentials, agentService, authService, pluginService, capabilities, permissions, systemPrompt, modelMetadata, resources, mcpService, terminalService, browserService);
  mainWindow = createWindow();

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}).catch((error: unknown) => {
  console.error("Application startup failed:", error instanceof Error ? error.stack ?? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  authService?.dispose();
  pluginService?.dispose();
  agentService?.dispose();
  void mcpService?.dispose();
  terminalService?.dispose();
  browserService?.dispose();
});
