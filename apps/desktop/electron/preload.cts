import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AuthEvent, PiDesktopApi, SaveModelSettings, SendPromptInput } from "../src/contracts.js";

const api: PiDesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    catalog: () => ipcRenderer.invoke("settings:catalog"),
    save: (settings: SaveModelSettings) => ipcRenderer.invoke("settings:save", settings),
    test: (settings: SaveModelSettings) => ipcRenderer.invoke("settings:test", settings),
  },
  auth: {
    login: (providerId) => ipcRenderer.invoke("auth:login", providerId),
    answer: (requestId, value) => ipcRenderer.invoke("auth:answer", requestId, value),
    cancel: (loginId) => ipcRenderer.invoke("auth:cancel", loginId),
    logout: (providerId) => ipcRenderer.invoke("auth:logout", providerId),
    onEvent: (listener: (event: AuthEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AuthEvent) => listener(payload);
      ipcRenderer.on("auth:event", handler);
      return () => ipcRenderer.removeListener("auth:event", handler);
    },
  },
  workspace: {
    choose: () => ipcRenderer.invoke("workspace:choose"),
  },
  agent: {
    send: (input: SendPromptInput) => ipcRenderer.invoke("agent:send", input),
    abort: () => ipcRenderer.invoke("agent:abort"),
    reset: () => ipcRenderer.invoke("agent:reset"),
    answerQuestion: (callId: string, answer: string) => ipcRenderer.invoke("agent:answer-question", callId, answer),
    onEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
      ipcRenderer.on("agent:event", handler);
      return () => ipcRenderer.removeListener("agent:event", handler);
    },
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);
