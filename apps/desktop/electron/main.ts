import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent, ModelMetadataOverride, PackageCapabilityProvider, PermissionSettings, SaveModelSettings, SendPromptInput, SubagentProvider } from "../src/contracts.js";
import { AgentService } from "./agent-service.js";
import { AuthService } from "./auth-service.js";
import { CapabilityStore } from "./capability-store.js";
import { EncryptedCredentialStore } from "./credential-store.js";
import { PluginService } from "./plugin-service.js";
import { PermissionStore } from "./permission-store.js";
import { SettingsStore } from "./settings-store.js";
import { ModelMetadataStore } from "./model-metadata-store.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let agentService: AgentService | undefined;
let authService: AuthService | undefined;
let pluginService: PluginService | undefined;

app.setName("Pi Desktop");
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

function registerIpc(
  settings: SettingsStore,
  credentials: EncryptedCredentialStore,
  agent: AgentService,
  auth: AuthService,
  plugins: PluginService,
  capabilities: CapabilityStore,
  permissions: PermissionStore,
  modelMetadata: ModelMetadataStore,
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
    return { name: path.basename(selectedPath), path: selectedPath };
  });
  ipcMain.handle("plugins:search", (_event, query: unknown, offset: unknown) => {
    return plugins.search(typeof query === "string" ? query : "", typeof offset === "number" ? offset : 0);
  });
  ipcMain.handle("plugins:details", (_event, name: unknown, version: unknown) => {
    return plugins.details(
      requireString(name, "插件包名无效。"),
      version === undefined ? undefined : requireString(version, "插件版本无效。"),
    );
  });
  ipcMain.handle("plugins:list", () => plugins.listInstalled());
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
  ipcMain.handle("agent:abort", () => agent.abort());
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
  );
  registerIpc(settings, credentials, agentService, authService, pluginService, capabilities, permissions, modelMetadata);
  mainWindow = createWindow();

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  authService?.dispose();
  pluginService?.dispose();
  agentService?.dispose();
});
