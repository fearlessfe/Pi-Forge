import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AuthEvent, ModelMetadataOverride, PiDesktopApi, PluginProgressEvent, SaveModelSettings, SendPromptInput } from "../src/contracts.js";

const api: PiDesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    catalog: () => ipcRenderer.invoke("settings:catalog"),
    refreshMetadata: () => ipcRenderer.invoke("settings:refresh-metadata"),
    saveMetadata: (providerId: string, modelId: string, metadata: ModelMetadataOverride) => ipcRenderer.invoke("settings:save-metadata", providerId, modelId, metadata),
    resetMetadata: (providerId: string, modelId: string) => ipcRenderer.invoke("settings:reset-metadata", providerId, modelId),
    discoverModels: (settings: SaveModelSettings) => ipcRenderer.invoke("settings:discover-models", settings),
    save: (settings: SaveModelSettings) => ipcRenderer.invoke("settings:save", settings),
    test: (settings: SaveModelSettings) => ipcRenderer.invoke("settings:test", settings),
  },
  permissions: {
    get: () => ipcRenderer.invoke("permissions:get"),
    save: (settings) => ipcRenderer.invoke("permissions:save", settings),
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
  plugins: {
    search: (query, offset) => ipcRenderer.invoke("plugins:search", query, offset),
    details: (name, version) => ipcRenderer.invoke("plugins:details", name, version),
    list: () => ipcRenderer.invoke("plugins:list"),
    install: (name, version) => ipcRenderer.invoke("plugins:install", name, version),
    remove: (source) => ipcRenderer.invoke("plugins:remove", source),
    reload: () => ipcRenderer.invoke("plugins:reload"),
    runtime: () => ipcRenderer.invoke("plugins:runtime"),
    setSubagentProvider: (provider) => ipcRenderer.invoke("plugins:set-subagent-provider", provider),
    setPackageCapability: (slot, provider) => ipcRenderer.invoke("plugins:set-package-capability", slot, provider),
    onEvent: (listener: (event: PluginProgressEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PluginProgressEvent) => listener(payload);
      ipcRenderer.on("plugins:event", handler);
      return () => ipcRenderer.removeListener("plugins:event", handler);
    },
  },
  agent: {
    send: (input: SendPromptInput) => ipcRenderer.invoke("agent:send", input),
    listConversations: () => ipcRenderer.invoke("agent:list-conversations"),
    loadConversation: (conversationId) => ipcRenderer.invoke("agent:load-conversation", conversationId),
    renameConversation: (conversationId, title) => ipcRenderer.invoke("agent:rename-conversation", conversationId, title),
    deleteConversation: (conversationId) => ipcRenderer.invoke("agent:delete-conversation", conversationId),
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
