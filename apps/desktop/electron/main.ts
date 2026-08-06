import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent, AppearancePreference, AppearanceTheme, SendPromptInput } from "../src/contracts.js";
import { AgentRuntimePool } from "./agent-runtime-pool.js";
import { ConversationProfileStore } from "./conversation-profile-store.js";
import { AppearanceStore } from "./appearance-store.js";
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
import { requireKnownWorkspace, resolveWorkspaceFileReference, seedKnownWorkspacesFromSessions } from "./workspace-guard.js";
import { McpStore } from "./mcp-store.js";
import { McpService } from "./mcp-service.js";
import { TerminalService } from "./terminal-service.js";
import { BrowserService } from "./browser-service.js";
import { normalizeExternalBrowserUrl } from "./browser-utils.js";
import { ObservabilityStore } from "./observability-store.js";
import { ObservabilityService } from "./observability-service.js";
import { shutdownApplication } from "./application-shutdown.js";
import {
  RendererCrashGuard,
  RendererEventJournal,
  rendererStableWindowMs,
  rendererUnresponsiveGraceMs,
} from "./renderer-recovery.js";
import {
  requireBrowserBounds,
  requireBrowserClearDataInput,
  requireBrowserMode,
  requireContextBudgetRequest,
  requireConversationListQuery,
  requireConversationExecutionProfile,
  requireMcpServerInput,
  requireModelMetadataOverride,
  requireModelSettings,
  requireObservabilitySettings,
  requirePackageCapabilityProvider,
  requirePermissionSettings,
  requireProjectResourceSelection,
  requireQueuePromptInput,
  requireResourceSettings,
  requireResolvePlanReviewInput,
  requireSendPromptInput,
  requireSubagentProvider,
  requireSystemPromptSettings,
} from "./ipc-input-validation.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let appearanceStore: AppearanceStore | undefined;
let agentService: AgentRuntimePool | undefined;
let authService: AuthService | undefined;
let pluginService: PluginService | undefined;
let mcpService: McpService | undefined;
let terminalService: TerminalService | undefined;
let browserService: BrowserService | undefined;
let observabilityService: ObservabilityService | undefined;
let applicationShutdownPromise: Promise<void> | undefined;
let applicationShutdownCompleted = false;
let rendererReady = false;
let rendererGeneration = 0;
let deliveredRecoveryGeneration = -1;
let rendererStableTimer: NodeJS.Timeout | undefined;
let rendererUnresponsiveTimer: NodeJS.Timeout | undefined;
let smokeTestStarted = false;
const rendererCrashGuard = new RendererCrashGuard();
const rendererEventJournal = new RendererEventJournal();
let rendererRecoveryLog = "";

/* 窗口/原生视图背景随主题切换，对齐 token v2 --bg-window（docs-internal/design-refresh-apple.md 3.2/3.6）。
   初始外观取 AppearanceStore 里最近一次偏好（无记录跟随系统）；macOS 使用透明原生材质，
   其余平台继续使用解析后的纯色背景，避免启动闪烁。 */
const windowBackground: Record<AppearanceTheme, string> = { dark: "#1C1C1E", light: "#F5F5F7" };
const nativeMaterialEnabled = process.platform === "darwin" && process.env.PI_DESKTOP_DISABLE_VIBRANCY !== "1";
const forcedThemeSource = process.env.PI_DESKTOP_THEME_SOURCE === "dark" || process.env.PI_DESKTOP_THEME_SOURCE === "light"
  ? process.env.PI_DESKTOP_THEME_SOURCE
  : undefined;

function applyNativeTheme(preference: AppearancePreference): void {
  nativeTheme.themeSource = forcedThemeSource ?? preference;
}

function refreshNativeMaterial(): void {
  if (!nativeMaterialEnabled || !mainWindow || mainWindow.isDestroyed()) return;
  // Electron 从显式 dark 恢复 system 时，NSVisualEffectView 可能保留旧的
  // dark appearance。重新绑定语义化 sidebar 材质，让它按新的系统外观重算。
  mainWindow.setVibrancy(null);
  mainWindow.setVibrancy("sidebar");
}

function initialWindowBackground(): string {
  if (nativeMaterialEnabled) return "#00000000";
  return windowBackground[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
}

app.setName("Pi Forge");
app.setPath("userData", process.env.PI_DESKTOP_USER_DATA
  ? path.resolve(process.env.PI_DESKTOP_USER_DATA)
  : path.join(app.getPath("appData"), "Pi Desktop"));
rendererRecoveryLog = path.join(app.getPath("userData"), "logs", "renderer-recovery.log");
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

function appendRendererRecoveryLog(event: string, details: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(path.dirname(rendererRecoveryLog), { recursive: true });
    fs.appendFileSync(rendererRecoveryLog, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("Renderer recovery log failed:", error instanceof Error ? error.message : String(error));
  }
}

function sendAgentEvent(event: AgentEvent): void {
  rendererEventJournal.record(event);
  if (rendererReady && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("agent:event", event);
  }
}

function startRendererGeneration(source: string): void {
  rendererReady = false;
  rendererGeneration += 1;
  clearTimeout(rendererStableTimer);
  clearTimeout(rendererUnresponsiveTimer);
  rendererCrashGuard.markResponsive();
  appendRendererRecoveryLog("renderer-unavailable", { source, generation: rendererGeneration });
}

function beginRendererReload(window: BrowserWindow, source: string): void {
  if (window.isDestroyed() || applicationShutdownPromise) return;
  startRendererGeneration(source);
  appendRendererRecoveryLog("reload", { source, generation: rendererGeneration });
  window.webContents.reload();
}

async function showRendererStoppedDialog(window: BrowserWindow, message: string): Promise<void> {
  if (window.isDestroyed() || applicationShutdownPromise) return;
  const result = await dialog.showMessageBox(window, {
    type: "error",
    title: "Pi Forge 界面需要恢复",
    message,
    detail: `Agent Runtime 仍在主进程中运行，不会自动重放工具调用。恢复日志：${rendererRecoveryLog}`,
    buttons: ["重新加载界面", "打开日志", "退出"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (result.response === 0) {
    rendererCrashGuard.markStable();
    beginRendererReload(window, "user");
  } else if (result.response === 1) {
    shell.showItemInFolder(rendererRecoveryLog);
  } else {
    app.quit();
  }
}

function installRendererRecovery(window: BrowserWindow): void {
  window.webContents.on("render-process-gone", (_event, details) => {
    if (applicationShutdownPromise || window.isDestroyed()) return;
    startRendererGeneration("render-process-gone");
    const decision = rendererCrashGuard.recordCrash();
    appendRendererRecoveryLog("render-process-gone", { ...details, crashCount: decision.count, generation: rendererGeneration });
    if (decision.action === "reload") {
      setTimeout(() => {
        if (!window.isDestroyed() && !applicationShutdownPromise) window.webContents.reload();
      }, decision.delayMs);
    } else {
      void showRendererStoppedDialog(window, "界面在一分钟内连续崩溃，已停止自动重载。");
    }
  });
  window.webContents.on("did-start-loading", () => {
    // Covers user/menu reloads and other same-process document replacements.
    // Crash and controlled-reload paths already started a generation above.
    if (rendererReady) startRendererGeneration("navigation");
  });
  window.on("unresponsive", () => {
    if (!rendererCrashGuard.markUnresponsive()) return;
    appendRendererRecoveryLog("unresponsive", { generation: rendererGeneration });
    rendererUnresponsiveTimer = setTimeout(() => {
      if (rendererCrashGuard.isUnresponsive()) {
        void showRendererStoppedDialog(window, "界面持续无响应。你可以等待、查看日志，或重新加载界面。");
      }
    }, rendererUnresponsiveGraceMs);
  });
  window.on("responsive", () => {
    if (!rendererCrashGuard.markResponsive()) return;
    clearTimeout(rendererUnresponsiveTimer);
    appendRendererRecoveryLog("responsive", { generation: rendererGeneration });
  });
  window.webContents.on("did-finish-load", () => {
    clearTimeout(rendererStableTimer);
    rendererStableTimer = setTimeout(() => {
      rendererCrashGuard.markStable();
      appendRendererRecoveryLog("stable", { generation: rendererGeneration });
    }, rendererStableWindowMs);
  });
}

function installPackagedSmoke(window: BrowserWindow): void {
  const resultFile = process.env.PI_DESKTOP_SMOKE_RESULT;
  if (!resultFile || smokeTestStarted) return;
  window.webContents.once("did-finish-load", () => {
    smokeTestStarted = true;
    void window.webContents.executeJavaScript(`(async () => {
      const api = window.piDesktop;
      if (!api) throw new Error("preload API is unavailable");
      await api.settings.get();
      await api.settings.catalog();
      await api.agent.listConversations();
      const terminal = await api.terminal.create(undefined, 80, 24);
      await api.terminal.kill(terminal.id);
      return { preload: true, ipc: true, runtime: true, terminal: true };
    })()`, true).then((checks) => {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, JSON.stringify({ ok: true, checks, version: app.getVersion() }));
      app.quit();
    }).catch((error: unknown) => {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      app.exit(1);
    });
  });
}

function installContentSecurityPolicy(): void {
  // Dev is intentionally looser: Vite's React preamble is an inline script and HMR needs the websocket.
  const policy = process.env.VITE_DEV_SERVER_URL
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:4173 http://127.0.0.1:4173"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

function createWindow(): BrowserWindow {
  startRendererGeneration("window-created");
  const rendererFile = path.join(currentDir, "../../dist/index.html");
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: initialWindowBackground(),
    ...(nativeMaterialEnabled ? { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const } : {}),
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  installRendererRecovery(window);
  installPackagedSmoke(window);
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

function registerIpc(
  settings: SettingsStore,
  credentials: EncryptedCredentialStore,
  agent: AgentRuntimePool,
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
  observability: ObservabilityService,
  appearance: AppearanceStore,
): void {
  const optionalKnownWorkspace = (value: unknown, message = "工作区路径无效。"): string | undefined => {
    if (value === undefined) return undefined;
    const resolved = requireString(value, message);
    requireKnownWorkspace(resources, resolved);
    return resolved;
  };
  ipcMain.handle("appearance:set-theme", (_event, preference: unknown, resolvedTheme: unknown) => {
    if (preference !== "dark" && preference !== "light" && preference !== "system") throw new Error("主题偏好无效。");
    if (resolvedTheme !== "dark" && resolvedTheme !== "light") throw new Error("解析后的主题无效。");
    appearance.save(preference);
    applyNativeTheme(preference);
    // 显式主题会同时改写渲染进程的 prefers-color-scheme。因此从 dark/light
    // 切回 system 时，渲染进程传来的 resolvedTheme 可能是旧值。必须在恢复
    // nativeTheme.themeSource 后由主进程重新解析，才能让 CSS 与 macOS 原生材质保持一致。
    const effectiveTheme: AppearanceTheme = preference === "system"
      ? nativeTheme.shouldUseDarkColors ? "dark" : "light"
      : preference;
    browser.setTheme(effectiveTheme);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(nativeMaterialEnabled ? "#00000000" : windowBackground[effectiveTheme]);
      refreshNativeMaterial();
    }
    return effectiveTheme;
  });
  ipcMain.handle("settings:get", () => settingsWithCredentials(settings, credentials));  ipcMain.handle("settings:catalog", () => agent.getModelCatalog());
  ipcMain.handle("settings:refresh-metadata", () => agent.getModelCatalog(true));
  ipcMain.handle("settings:save-metadata", async (_event, providerId: unknown, modelId: unknown, value: unknown) => {
    modelMetadata.save(
      requireString(providerId, "模型提供商无效。"),
      requireString(modelId, "模型 ID 无效。"),
      requireModelMetadataOverride(value),
    );
    await agent.reset();
    return agent.getModelCatalog(false);
  });
  ipcMain.handle("settings:reset-metadata", async (_event, providerId: unknown, modelId: unknown) => {
    modelMetadata.reset(requireString(providerId, "模型提供商无效。"), requireString(modelId, "模型 ID 无效。"));
    await agent.reset();
    return agent.getModelCatalog(false);
  });
  ipcMain.handle("settings:discover-models", (_event, value: unknown) => agent.discoverModels(requireModelSettings(value)));
  ipcMain.handle("settings:save", async (_event, value: unknown) => {
    await agent.reset();
    const input = requireModelSettings(value);
    settings.save({ ...input, apiKey: undefined });
    if (input.apiKey?.trim()) {
      await credentials.modify(input.provider, async () => ({ type: "api_key", key: input.apiKey?.trim() }));
    }
    await agent.updateConfiguration();
    return settingsWithCredentials(settings, credentials);
  });
  ipcMain.handle("settings:test", async (_event, value: unknown) => {
    const response = await agent.testConfiguration(requireModelSettings(value));
    return { ok: true as const, response };
  });
  ipcMain.handle("observability:get", () => observability.getSettings());
  ipcMain.handle("observability:status", () => observability.status());
  ipcMain.handle("observability:save", (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待当前任务结束后再修改 Trace 设置。");
    return observability.saveSettings(requireObservabilitySettings(value));
  });
  ipcMain.handle("observability:flush", async () => {
    await observability.flush();
    return observability.status();
  });
  ipcMain.handle("permissions:get", () => agent.getPermissionRuntime());
  ipcMain.handle("permissions:save", async (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改权限模式。");
    permissions.save(requirePermissionSettings(value));
    return agent.getPermissionRuntime();
  });
  ipcMain.handle("system-prompt:get", () => systemPrompt.get());
  ipcMain.handle("system-prompt:save", async (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改系统提示词。");
    const saved = systemPrompt.save(requireSystemPromptSettings(value));
    await agent.reset();
    return saved;
  });
  ipcMain.handle("auth:login", async (_event, providerId: unknown) => {
    await agent.reset();
    return { loginId: await auth.login(requireString(providerId, "模型提供商无效。")) };
  });
  ipcMain.handle("auth:answer", (_event, requestId: unknown, value: unknown) => {
    auth.answer(requireString(requestId, "登录问题无效。"), typeof value === "string" ? value : "");
  });
  ipcMain.handle("auth:cancel", (_event, loginId: unknown) => {
    auth.cancel(requireString(loginId, "登录任务无效。"));
  });
  ipcMain.handle("auth:logout", async (_event, providerId: unknown) => {
    await agent.reset();
    await auth.logout(requireString(providerId, "模型提供商无效。"));
  });
  ipcMain.handle("workspace:choose", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Agent 工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selectedPath = resources.addKnownWorkspace(result.filePaths[0]);
    return { name: path.basename(selectedPath), ...resources.getTrustStatus(selectedPath) };
  });
  ipcMain.handle("workspace:trust-status", (_event, value: unknown) => {
    const workspacePath = requireString(value, "工作区路径无效。");
    requireKnownWorkspace(resources, workspacePath);
    return resources.getTrustStatus(workspacePath);
  });
  ipcMain.handle("workspace:set-trusted", async (_event, value: unknown, trusted: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改项目信任状态。");
    if (typeof trusted !== "boolean") throw new Error("项目信任状态无效。");
    const workspacePath = requireString(value, "工作区路径无效。");
    requireKnownWorkspace(resources, workspacePath);
    const status = resources.setProjectTrusted(workspacePath, trusted);
    await agent.reset();
    return status;
  });
  ipcMain.handle("workspace:open-file", async (_event, cwd: unknown, reference: unknown) => {
    const filePath = resolveWorkspaceFileReference(
      resources,
      requireString(cwd, "工作区路径无效。"),
      requireString(reference, "工作区文件引用无效。"),
    );
    const failure = await shell.openPath(filePath);
    if (failure) throw new Error(`无法打开文件：${failure}`);
  });
  ipcMain.handle("resources:get-settings", () => resources.getSettings());
  ipcMain.handle("resources:save-settings", async (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改资源设置。");
    const saved = resources.saveSettings(requireResourceSettings(value));
    await agent.reset();
    return saved;
  });
  ipcMain.handle("resources:inventory", (_event, cwd: unknown) => agent.getResourceInventory(optionalKnownWorkspace(cwd)));
  ipcMain.handle("resources:context-budget", (_event, value: unknown) => {
    const input = requireContextBudgetRequest(value);
    return agent.getContextBudget(optionalKnownWorkspace(input.cwd));
  });
  ipcMain.handle("resources:set-skill-enabled", async (_event, name: unknown, enabled: unknown, cwd: unknown, scope: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改 Skill。");
    const skillName = requireString(name, "Skill 名称无效。");
    if (typeof enabled !== "boolean") throw new Error("Skill 状态无效。");
    if (scope === "project") {
      const workspacePath = optionalKnownWorkspace(cwd, "当前项目无效。");
      if (!workspacePath) throw new Error("项目级 Skill 设置需要当前项目。");
      resources.setProjectSkillEnabled(workspacePath, skillName, enabled);
    } else {
      if (scope !== undefined && scope !== "user") throw new Error("Skill 设置作用域无效。");
      const current = resources.getSettings();
      const disabledSkills = enabled
        ? current.disabledSkills.filter((entry) => entry !== skillName)
        : [...new Set([...current.disabledSkills, skillName])];
      resources.saveSettings({ ...current, disabledSkills });
    }
    await agent.reset();
    return agent.getResourceInventory(optionalKnownWorkspace(cwd));
  });
  ipcMain.handle("resources:set-project-selection", async (_event, cwd: unknown, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改项目资源。");
    const workspacePath = optionalKnownWorkspace(cwd, "当前项目无效。");
    if (!workspacePath) throw new Error("项目资源选择需要当前项目。");
    const selection = requireProjectResourceSelection(value);
    if (selection) {
      const [inventory, overview] = await Promise.all([
        agent.getResourceInventory(workspacePath),
        Promise.resolve(mcp.overview(workspacePath)),
      ]);
      const knownSkills = new Set(inventory.skills.map((skill) => skill.name));
      const knownServers = new Set(overview.servers.map((server) => server.key));
      if (selection.skills.some((name) => !knownSkills.has(name))
        || selection.mcpServers.some((key) => !knownServers.has(key))) {
        throw new Error("项目资源选择包含未知资源，请刷新后重试。");
      }
      resources.setProjectSelection(workspacePath, selection);
      for (const server of overview.servers) {
        if (!selection.mcpServers.includes(server.key)) await mcp.disconnect(server.key, workspacePath);
      }
    } else {
      resources.setProjectSelection(workspacePath);
    }
    await agent.reset();
    return resources.getProjectSettings(workspacePath);
  });
  ipcMain.handle("resources:execute-extension-command", async (_event, value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("命令格式无效。");
    const input = value as SendPromptInput;
    if (typeof input.prompt !== "string" || (input.cwd !== undefined && typeof input.cwd !== "string") || (input.conversationId !== undefined && typeof input.conversationId !== "string")) {
      throw new Error("命令字段无效。");
    }
    if (input.cwd !== undefined) requireKnownWorkspace(resources, input.cwd);
    return { handled: await agent.executeExtensionCommand(input.prompt, input.cwd, input.conversationId) };
  });
  ipcMain.handle("mcp:overview", (_event, cwd: unknown) => mcp.overview(optionalKnownWorkspace(cwd)));
  ipcMain.handle("mcp:save", async (_event, value: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改 MCP 配置。");
    const overview = mcp.save(requireMcpServerInput(value));
    await agent.reset();
    return overview;
  });
  ipcMain.handle("mcp:remove", async (_event, key: unknown, cwd: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再删除 MCP Server。");
    const overview = await mcp.remove(requireString(key, "MCP Server 无效。"), optionalKnownWorkspace(cwd));
    await agent.reset();
    return overview;
  });
  ipcMain.handle("mcp:connect", (_event, key: unknown, cwd: unknown) => mcp.connect(requireString(key, "MCP Server 无效。"), optionalKnownWorkspace(cwd)));
  ipcMain.handle("mcp:disconnect", (_event, key: unknown, cwd: unknown) => mcp.disconnect(requireString(key, "MCP Server 无效。"), optionalKnownWorkspace(cwd)));
  ipcMain.handle("mcp:reconnect", (_event, key: unknown, cwd: unknown) => mcp.reconnect(requireString(key, "MCP Server 无效。"), optionalKnownWorkspace(cwd)));
  ipcMain.handle("mcp:set-project-enabled", async (_event, key: unknown, enabled: unknown, cwd: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改 MCP 配置。");
    if (typeof enabled !== "boolean") throw new Error("MCP Server 项目状态无效。");
    const workspacePath = optionalKnownWorkspace(cwd, "当前项目无效。");
    if (!workspacePath) throw new Error("项目级 MCP 设置需要当前项目。");
    const serverKey = requireString(key, "MCP Server 无效。");
    if (!mcp.overview(workspacePath).servers.some((server) => server.key === serverKey)) throw new Error("找不到该 MCP Server。");
    resources.setProjectMcpServerEnabled(workspacePath, serverKey, enabled);
    if (!enabled) await mcp.disconnect(serverKey, workspacePath);
    await agent.reset();
    return mcp.overview(workspacePath);
  });
  ipcMain.handle("terminal:create", (_event, cwd: unknown, cols: unknown, rows: unknown) => terminal.create(
    optionalKnownWorkspace(cwd, "终端工作目录无效。"),
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
  ipcMain.handle("browser:open-external", (_event, url: unknown) => shell.openExternal(
    normalizeExternalBrowserUrl(requireString(url, "浏览器地址无效。")),
  ));
  ipcMain.handle("browser:back", () => browser.back());
  ipcMain.handle("browser:forward", () => browser.forward());
  ipcMain.handle("browser:reload", () => browser.reload());
  ipcMain.handle("browser:stop", () => browser.stop());
  ipcMain.handle("browser:set-mode", (_event, mode: unknown) => browser.setMode(requireBrowserMode(mode)));
  ipcMain.handle("browser:clear-data", (_event, input: unknown) => browser.clearData(requireBrowserClearDataInput(input)));
  ipcMain.handle("browser:set-visible", (_event, visible: unknown) => {
    if (typeof visible !== "boolean") throw new Error("浏览器可见状态无效。");
    return browser.setVisible(visible);
  });
  ipcMain.handle("browser:set-bounds", (_event, value: unknown) => {
    browser.setBounds(requireBrowserBounds(value));
  });
  ipcMain.handle("browser:start-annotation", (_event, prompt: unknown) => browser.startAnnotation(
    undefined,
    typeof prompt === "string" ? prompt : "",
    undefined,
    "browser-workbench",
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
  ipcMain.handle("plugins:list", (_event, cwd: unknown) => plugins.listInstalled(optionalKnownWorkspace(cwd)));
  ipcMain.handle("plugins:install", async (_event, name: unknown, version: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再安装插件。");
    const installed = await plugins.install(
      requireString(name, "插件包名无效。"),
      requireString(version, "插件版本无效。"),
    );
    const reloaded = await agent.reloadPackages();
    return { installed, reloaded, runtime: await agent.getPluginRuntime() };
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
    return { installed, reloaded, runtime: await agent.getPluginRuntime() };
  });
  ipcMain.handle("plugins:reload", async () => {
    const reloaded = await agent.reloadPackages();
    return { reloaded, runtime: await agent.getPluginRuntime() };
  });
  ipcMain.handle("plugins:set-enabled", async (_event, source: unknown, enabled: unknown, cwd: unknown, scope: unknown) => {
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再切换插件状态。");
    if (typeof enabled !== "boolean") throw new Error("插件启停状态无效。");
    if (scope !== undefined && scope !== "user" && scope !== "project") throw new Error("插件启停范围无效。");
    const packageSource = requireString(source, "插件安装来源无效。");
    const projectPath = optionalKnownWorkspace(cwd);
    const installed = await plugins.setEnabled(packageSource, enabled, projectPath, scope === "project" ? "project" : "user");
    if (!enabled) {
      const currentCapabilities = capabilities.get();
      if (currentCapabilities.subagent.kind === "plugin" && currentCapabilities.subagent.source === packageSource) capabilities.saveSubagent({ kind: "builtin" });
      if (currentCapabilities.memory.kind === "plugin" && currentCapabilities.memory.source === packageSource) capabilities.savePackageCapability("memory", { kind: "none" });
      if (currentCapabilities.learning.kind === "plugin" && currentCapabilities.learning.source === packageSource) capabilities.savePackageCapability("learning", { kind: "none" });
    }
    const reloaded = await agent.reloadPackages();
    return { installed, reloaded, runtime: await agent.getPluginRuntime() };
  });
  ipcMain.handle("plugins:runtime", () => agent.getPluginRuntime());
  ipcMain.handle("plugins:set-subagent-provider", async (_event, value: unknown) => {
    const provider = requireSubagentProvider(value);
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再切换能力提供者。");
    if (provider.kind === "plugin" && !(await agent.getPluginRuntime()).hasSession) {
      throw new Error("请先创建一次 Agent 会话，再 Reload 并选择实际加载的第三方工具。");
    }
    const previous = capabilities.get().subagent;
    capabilities.saveSubagent(provider);
    const reloaded = await agent.reloadPackages();
    const status = await agent.getPluginRuntime();
    if (!reloaded || provider.kind !== "plugin") return status;
    const matches = status.effectiveSubagent.kind === "plugin"
      && status.effectiveSubagent.source === provider.source
      && status.effectiveSubagent.toolName === provider.toolName;
    if (matches) return status;
    const reason = status.fallbackReason ?? `${provider.source} 没有成功提供 ${provider.toolName}。`;
    capabilities.saveSubagent(previous);
    await agent.reloadPackages();
    return { ...await agent.getPluginRuntime(), fallbackReason: `${reason} 已恢复上一个 Subagent 提供者。` };
  });
  ipcMain.handle("plugins:set-package-capability", async (_event, slotValue: unknown, value: unknown) => {
    if (slotValue !== "memory" && slotValue !== "learning") throw new Error("能力槽无效。");
    const provider = requirePackageCapabilityProvider(value);
    if (agent.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再切换能力提供者。");
    if (provider.kind === "plugin" && !(await agent.getPluginRuntime()).hasSession) {
      throw new Error("请先创建一次 Agent 会话，再 Reload 并验证该插件后切换能力提供者。");
    }
    const previous = capabilities.get()[slotValue];
    capabilities.savePackageCapability(slotValue, provider);
    const reloaded = await agent.reloadPackages();
    const status = await agent.getPluginRuntime();
    const effective = slotValue === "memory" ? status.effectiveMemory : status.effectiveLearning;
    if (!reloaded || provider.kind !== "plugin") return status;
    const matches = effective.kind === "plugin" && effective.source === provider.source;
    if (matches) return status;
    capabilities.savePackageCapability(slotValue, previous);
    await agent.reloadPackages();
    return {
      ...await agent.getPluginRuntime(),
      fallbackReason: `${provider.source} 没有成功加载，已恢复上一个${slotValue === "memory" ? "记忆" : "自学习"}提供者。`,
    };
  });
  ipcMain.handle("agent:send", async (_event, value: unknown) => {
    const input = requireSendPromptInput(value);
    if (input.cwd !== undefined) requireKnownWorkspace(resources, input.cwd);
    const conversationId = requireString(input.conversationId, "启动任务必须指定会话 ID。");
    const runId = await agent.send(input.prompt, input.cwd, conversationId, {
      images: input.images,
      attachments: input.attachments,
    });
    return { runId };
  });
  ipcMain.handle("agent:list-conversations", () => agent.listConversations());
  ipcMain.handle("agent:list-conversation-page", (_event, query: unknown) => agent.listConversationPage(requireConversationListQuery(query)));
  ipcMain.handle("agent:load-conversation", (_event, conversationId: unknown) => agent.loadConversation(requireString(conversationId, "会话 ID 无效。")));
  ipcMain.handle("agent:get-profile", (_event, conversationId: unknown, cwd: unknown) => {
    const resolvedCwd = cwd === undefined ? undefined : optionalKnownWorkspace(cwd);
    return agent.getProfile(requireString(conversationId, "会话 ID 无效。"), resolvedCwd);
  });
  ipcMain.handle("agent:save-profile", (_event, value: unknown) => {
    const profile = requireConversationExecutionProfile(value);
    requireKnownWorkspace(resources, profile.cwd);
    return agent.saveProfile(profile);
  });
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
  ipcMain.handle("agent:abort", (_event, conversationId: unknown) => agent.abort(requireString(conversationId, "会话 ID 无效。")));
  ipcMain.handle("agent:queue", (_event, value: unknown) => {
    const input = requireQueuePromptInput(value);
    return agent.queueMessage(input.conversationId, input.prompt, input.mode, {
      images: input.images,
      attachments: input.attachments,
    });
  });
  ipcMain.handle("agent:clear-queue", (_event, conversationId: unknown) => agent.clearQueue(requireString(conversationId, "会话 ID 无效。")));
  ipcMain.handle("agent:list-changes", (_event, conversationId: unknown, runId: unknown) => agent.listChanges(requireString(conversationId, "会话 ID 无效。"), runId === undefined ? undefined : requireString(runId, "任务 ID 无效。")));
  ipcMain.handle("agent:accept-changes", (_event, conversationId: unknown, changeIds: unknown) => {
    if (changeIds !== undefined && (!Array.isArray(changeIds) || changeIds.some((entry) => typeof entry !== "string"))) throw new Error("文件变更 ID 无效。");
    return agent.acceptChanges(requireString(conversationId, "会话 ID 无效。"), changeIds as string[] | undefined);
  });
  ipcMain.handle("agent:revert-changes", (_event, conversationId: unknown, changeIds: unknown) => {
    const id = requireString(conversationId, "会话 ID 无效。");
    if (agent.isRunning(id)) throw new Error("该会话的 Agent 正在执行，请等待任务完成后再回退文件变更。");
    if (changeIds !== undefined && (!Array.isArray(changeIds) || changeIds.some((entry) => typeof entry !== "string"))) throw new Error("文件变更 ID 无效。");
    return agent.revertChanges(id, changeIds as string[] | undefined);
  });
  ipcMain.handle("agent:open-change", async (_event, conversationId: unknown, changeId: unknown) => {
    const filePath = await agent.changePath(requireString(conversationId, "会话 ID 无效。"), requireString(changeId, "文件变更 ID 无效。"));
    const failure = await shell.openPath(filePath);
    if (failure) throw new Error(`无法打开文件：${failure}`);
  });
  ipcMain.handle("agent:reveal-change", async (_event, conversationId: unknown, changeId: unknown) => {
    shell.showItemInFolder(await agent.changePath(requireString(conversationId, "会话 ID 无效。"), requireString(changeId, "文件变更 ID 无效。")));
  });
  ipcMain.handle("agent:answer-question", (_event, conversationId: unknown, callId: unknown, answer: unknown) => {
    if (typeof callId !== "string" || typeof answer !== "string") throw new Error("回答格式无效。");
    return agent.answerQuestion(requireString(conversationId, "会话 ID 无效。"), callId, answer);
  });
  ipcMain.handle("agent:list-plan-reviews", (_event, conversationId: unknown) => agent.listPlanReviews(
    conversationId === undefined ? undefined : requireString(conversationId, "对话 ID 无效。"),
  ));
  ipcMain.handle("agent:resolve-plan-review", (_event, conversationId: unknown, value: unknown) => agent.resolvePlanReview(requireString(conversationId, "会话 ID 无效。"), requireResolvePlanReviewInput(value)));
  ipcMain.handle("agent:reset", (_event, conversationId: unknown) => agent.reset(conversationId === undefined ? undefined : requireString(conversationId, "会话 ID 无效。")));
  ipcMain.handle("agent:list-recoveries", () => agent.listRecoveries());
  ipcMain.handle("agent:retry-recovery", async (_event, id: unknown) => ({ runId: await agent.retryRecovery(requireString(id, "恢复任务无效。")) }));
  ipcMain.handle("agent:discard-recovery", (_event, id: unknown) => agent.discardRecovery(requireString(id, "恢复任务无效。")));
  ipcMain.handle("agent:retry-runtime", (_event, conversationId: unknown) => agent.retryAfterCrashLoop(
    conversationId === undefined ? undefined : requireString(conversationId, "会话 ID 无效。"),
  ));
  ipcMain.handle("agent:reconnect", () => {
    rendererReady = true;
    const snapshot = rendererEventJournal.snapshot();
    if (deliveredRecoveryGeneration === rendererGeneration) return { ...snapshot, events: [] };
    deliveredRecoveryGeneration = rendererGeneration;
    appendRendererRecoveryLog("renderer-ready", { generation: rendererGeneration, replayedEvents: snapshot.events.length });
    return snapshot;
  });
}

if (isPrimaryInstance) void app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const piDesktopHome = process.env.PI_DESKTOP_HOME
    ? path.resolve(process.env.PI_DESKTOP_HOME)
    : path.join(os.homedir(), ".pi-desktop");
  const chatSandbox = path.join(piDesktopHome, "workspace");
  const sessionDir = path.join(piDesktopHome, "sessions");
  const settings = new SettingsStore(userData);
  appearanceStore = new AppearanceStore(userData);
  applyNativeTheme(appearanceStore.get());
  const observabilityStore = new ObservabilityStore(userData);
  observabilityService = new ObservabilityService(observabilityStore, userData);
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
  void browserService.cleanupArtifacts().catch((error: unknown) => {
    console.error("Browser artifact cleanup failed:", error instanceof Error ? error.message : String(error));
  });
  const systemPrompt = new SystemPromptStore(path.join(userData, "pi-agent"));
  try {
    await migrateLegacyApiKeys(settings, credentials);
  } catch (error) {
    console.error("Credential migration failed:", error instanceof Error ? error.message : String(error));
  }
  agentService = new AgentRuntimePool({
    workerPath: path.join(currentDir, "agent-runtime-worker.js"),
    userDataPath: userData,
    agentDir: path.join(userData, "pi-agent"),
    fallbackCwd: chatSandbox,
    sessionDir,
    settings,
    profiles: new ConversationProfileStore(userData),
    resources,
    credentials,
    mcp: mcpService,
    browser: browserService,
    emit: sendAgentEvent,
    observe: (event, prompt) => observabilityService?.record(event, prompt),
  });
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
  // The fallback workspace is always allowed; seed the rest from existing sessions
  // so conversations created before the workspace restriction keep loading.
  resources.addKnownWorkspace(chatSandbox);
  seedKnownWorkspacesFromSessions(resources, [sessionDir]);
  registerIpc(settings, credentials, agentService, authService, pluginService, capabilities, permissions, systemPrompt, modelMetadata, resources, mcpService, terminalService, browserService, observabilityService, appearanceStore);
  installContentSecurityPolicy();
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

app.on("before-quit", (event) => {
  if (applicationShutdownCompleted) return;
  event.preventDefault();
  applicationShutdownPromise ??= shutdownApplication([
    { name: "auth", run: () => authService?.dispose() },
    { name: "plugins", run: () => pluginService?.dispose() },
    { name: "runtime", run: () => agentService?.dispose() },
    { name: "mcp", run: async () => mcpService?.dispose() },
    { name: "terminal", run: () => terminalService?.dispose() },
    { name: "browser", run: () => browserService?.dispose() },
    { name: "observability", run: async () => observabilityService?.shutdown() },
  ], 5_000).then((result) => {
    for (const failure of result.failures) console.error(`Application shutdown failed (${failure.name}): ${failure.message}`);
    if (result.timedOut.length > 0) console.error(`Application shutdown timed out: ${result.timedOut.join(", ")}`);
  }).finally(() => {
    applicationShutdownCompleted = true;
    app.quit();
  });
});
