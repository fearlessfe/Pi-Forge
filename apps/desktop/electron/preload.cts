import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, PiDesktopApi, SaveModelSettings, SendPromptInput } from "../src/contracts.js";

const api: PiDesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings: SaveModelSettings) => ipcRenderer.invoke("settings:save", settings),
    test: (settings: SaveModelSettings) => ipcRenderer.invoke("settings:test", settings),
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
