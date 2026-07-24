import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent, SaveModelSettings, SendPromptInput } from "../src/contracts.js";
import { AgentService } from "./agent-service.js";
import { SettingsStore } from "./settings-store.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let agentService: AgentService | undefined;

app.setName("Pi Desktop");
app.setPath("userData", process.env.PI_DESKTOP_USER_DATA
  ? path.resolve(process.env.PI_DESKTOP_USER_DATA)
  : path.join(app.getPath("appData"), "Pi Desktop"));

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

function registerIpc(settings: SettingsStore, agent: AgentService): void {
  ipcMain.handle("settings:get", () => settings.get());
  ipcMain.handle("settings:save", (_event, value: unknown) => {
    agent.reset();
    return settings.save(requireSettings(value));
  });
  ipcMain.handle("settings:test", async (_event, value: unknown) => {
    const response = await agent.testConfiguration(requireSettings(value));
    return { ok: true as const, response };
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

void app.whenReady().then(() => {
  const userData = app.getPath("userData");
  const settings = new SettingsStore(userData);
  agentService = new AgentService(
    settings,
    path.join(userData, "pi-agent"),
    path.join(userData, "chat-sandbox"),
    sendAgentEvent,
  );
  registerIpc(settings, agentService);
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => agentService?.dispose());
