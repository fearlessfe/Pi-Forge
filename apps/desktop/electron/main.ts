import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent, SaveModelSettings, SendPromptInput } from "../src/contracts.js";
import { AgentService } from "./agent-service.js";
import { AuthService } from "./auth-service.js";
import { EncryptedCredentialStore } from "./credential-store.js";
import { SettingsStore } from "./settings-store.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let agentService: AgentService | undefined;
let authService: AuthService | undefined;

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

function registerIpc(
  settings: SettingsStore,
  credentials: EncryptedCredentialStore,
  agent: AgentService,
  auth: AuthService,
): void {
  ipcMain.handle("settings:get", () => settingsWithCredentials(settings, credentials));
  ipcMain.handle("settings:catalog", () => agent.getModelCatalog());
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
  ipcMain.handle("agent:send", async (_event, value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("消息格式无效。");
    const input = value as SendPromptInput;
    if (typeof input.prompt !== "string" || (input.cwd !== undefined && typeof input.cwd !== "string")) {
      throw new Error("消息字段无效。");
    }
    const runId = await agent.send(input.prompt, input.cwd);
    return { runId };
  });
  ipcMain.handle("agent:abort", () => agent.abort());
  ipcMain.handle("agent:answer-question", (_event, callId: unknown, answer: unknown) => {
    if (typeof callId !== "string" || typeof answer !== "string") throw new Error("回答格式无效。");
    agent.answerQuestion(callId, answer);
  });
  ipcMain.handle("agent:reset", () => agent.reset());
}

if (isPrimaryInstance) void app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const settings = new SettingsStore(userData);
  const credentials = new EncryptedCredentialStore(userData);
  try {
    await migrateLegacyApiKeys(settings, credentials);
  } catch (error) {
    console.error("Credential migration failed:", error instanceof Error ? error.message : String(error));
  }
  agentService = new AgentService(
    settings,
    path.join(userData, "pi-agent"),
    path.join(userData, "chat-sandbox"),
    sendAgentEvent,
    credentials,
  );
  authService = new AuthService(
    credentials,
    path.join(userData, "pi-agent"),
    (event) => mainWindow?.webContents.send("auth:event", event),
    (url) => shell.openExternal(url),
  );
  registerIpc(settings, credentials, agentService, authService);
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
  agentService?.dispose();
});
