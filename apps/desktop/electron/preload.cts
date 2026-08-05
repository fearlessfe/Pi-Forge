import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AuthEvent, BrowserEvent, ModelMetadataOverride, PiDesktopApi, PluginProgressEvent, QueuePromptInput, SaveModelSettings, SaveObservabilitySettings, SendPromptInput, TerminalEvent } from "../src/contracts.js";

const api: PiDesktopApi = {
  appearance: {
    nativeMaterial: process.platform === "darwin" && process.env.PI_DESKTOP_DISABLE_VIBRANCY !== "1",
    setTheme: (preference, resolvedTheme) => ipcRenderer.invoke("appearance:set-theme", preference, resolvedTheme),
  },
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
  systemPrompt: {
    get: () => ipcRenderer.invoke("system-prompt:get"),
    save: (settings) => ipcRenderer.invoke("system-prompt:save", settings),
  },
  observability: {
    get: () => ipcRenderer.invoke("observability:get"),
    save: (settings: SaveObservabilitySettings) => ipcRenderer.invoke("observability:save", settings),
    status: () => ipcRenderer.invoke("observability:status"),
    flush: () => ipcRenderer.invoke("observability:flush"),
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
    trustStatus: (path) => ipcRenderer.invoke("workspace:trust-status", path),
    setTrusted: (path, trusted) => ipcRenderer.invoke("workspace:set-trusted", path, trusted),
    openFile: (cwd, reference) => ipcRenderer.invoke("workspace:open-file", cwd, reference),
  },
  resources: {
    getSettings: () => ipcRenderer.invoke("resources:get-settings"),
    saveSettings: (settings) => ipcRenderer.invoke("resources:save-settings", settings),
    inventory: (cwd) => ipcRenderer.invoke("resources:inventory", cwd),
    contextBudget: (input) => ipcRenderer.invoke("resources:context-budget", input ?? {}),
    setSkillEnabled: (name, enabled, cwd, scope) => ipcRenderer.invoke("resources:set-skill-enabled", name, enabled, cwd, scope),
    setProjectSelection: (cwd, selection) => ipcRenderer.invoke("resources:set-project-selection", cwd, selection),
    executeExtensionCommand: (input) => ipcRenderer.invoke("resources:execute-extension-command", input),
  },
  mcp: {
    overview: (cwd) => ipcRenderer.invoke("mcp:overview", cwd),
    save: (server) => ipcRenderer.invoke("mcp:save", server),
    remove: (key, cwd) => ipcRenderer.invoke("mcp:remove", key, cwd),
    connect: (key, cwd) => ipcRenderer.invoke("mcp:connect", key, cwd),
    disconnect: (key, cwd) => ipcRenderer.invoke("mcp:disconnect", key, cwd),
    reconnect: (key, cwd) => ipcRenderer.invoke("mcp:reconnect", key, cwd),
    setProjectEnabled: (key, enabled, cwd) => ipcRenderer.invoke("mcp:set-project-enabled", key, enabled, cwd),
  },
  terminal: {
    create: (cwd, cols, rows) => ipcRenderer.invoke("terminal:create", cwd, cols, rows),
    list: () => ipcRenderer.invoke("terminal:list"),
    write: (id, data) => ipcRenderer.invoke("terminal:write", id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke("terminal:resize", id, cols, rows),
    kill: (id) => ipcRenderer.invoke("terminal:kill", id),
    onEvent: (listener: (event: TerminalEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalEvent) => listener(payload);
      ipcRenderer.on("terminal:event", handler);
      return () => ipcRenderer.removeListener("terminal:event", handler);
    },
  },
  browser: {
    state: () => ipcRenderer.invoke("browser:state"),
    navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
    openExternal: (url) => ipcRenderer.invoke("browser:open-external", url),
    back: () => ipcRenderer.invoke("browser:back"),
    forward: () => ipcRenderer.invoke("browser:forward"),
    reload: () => ipcRenderer.invoke("browser:reload"),
    stop: () => ipcRenderer.invoke("browser:stop"),
    setBounds: (bounds) => ipcRenderer.invoke("browser:set-bounds", bounds),
    setVisible: (visible) => ipcRenderer.invoke("browser:set-visible", visible),
    startAnnotation: (prompt) => ipcRenderer.invoke("browser:start-annotation", prompt),
    cancelAnnotation: () => ipcRenderer.invoke("browser:cancel-annotation"),
    onEvent: (listener: (event: BrowserEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: BrowserEvent) => listener(payload);
      ipcRenderer.on("browser:event", handler);
      return () => ipcRenderer.removeListener("browser:event", handler);
    },
  },
  plugins: {
    search: (query, offset) => ipcRenderer.invoke("plugins:search", query, offset),
    details: (name, version) => ipcRenderer.invoke("plugins:details", name, version),
    list: (cwd) => ipcRenderer.invoke("plugins:list", cwd),
    install: (name, version) => ipcRenderer.invoke("plugins:install", name, version),
    remove: (source) => ipcRenderer.invoke("plugins:remove", source),
    reload: () => ipcRenderer.invoke("plugins:reload"),
    setEnabled: (source, enabled, cwd, scope) => ipcRenderer.invoke("plugins:set-enabled", source, enabled, cwd, scope),
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
    listConversationPage: (query) => ipcRenderer.invoke("agent:list-conversation-page", query ?? {}),
    loadConversation: (conversationId) => ipcRenderer.invoke("agent:load-conversation", conversationId),
    getProfile: (conversationId, cwd) => ipcRenderer.invoke("agent:get-profile", conversationId, cwd),
    saveProfile: (profile) => ipcRenderer.invoke("agent:save-profile", profile),
    renameConversation: (conversationId, title) => ipcRenderer.invoke("agent:rename-conversation", conversationId, title),
    forkConversation: (conversationId, entryId) => ipcRenderer.invoke("agent:fork-conversation", conversationId, entryId),
    exportConversation: (conversationId, format) => ipcRenderer.invoke("agent:export-conversation", conversationId, format),
    setConversationArchived: (conversationId, archived) => ipcRenderer.invoke("agent:set-conversation-archived", conversationId, archived),
    setConversationTags: (conversationId, tags) => ipcRenderer.invoke("agent:set-conversation-tags", conversationId, tags),
    deleteConversation: (conversationId) => ipcRenderer.invoke("agent:delete-conversation", conversationId),
    abort: (conversationId) => ipcRenderer.invoke("agent:abort", conversationId),
    queue: (input: QueuePromptInput) => ipcRenderer.invoke("agent:queue", input),
    clearQueue: (conversationId) => ipcRenderer.invoke("agent:clear-queue", conversationId),
    listChanges: (conversationId, runId) => ipcRenderer.invoke("agent:list-changes", conversationId, runId),
    acceptChanges: (conversationId, changeIds) => ipcRenderer.invoke("agent:accept-changes", conversationId, changeIds),
    revertChanges: (conversationId, changeIds) => ipcRenderer.invoke("agent:revert-changes", conversationId, changeIds),
    openChange: (conversationId, changeId) => ipcRenderer.invoke("agent:open-change", conversationId, changeId),
    revealChange: (conversationId, changeId) => ipcRenderer.invoke("agent:reveal-change", conversationId, changeId),
    reset: (conversationId) => ipcRenderer.invoke("agent:reset", conversationId),
    answerQuestion: (conversationId: string, callId: string, answer: string) => ipcRenderer.invoke("agent:answer-question", conversationId, callId, answer),
    listPlanReviews: (conversationId?: string) => ipcRenderer.invoke("agent:list-plan-reviews", conversationId),
    resolvePlanReview: (conversationId, input) => ipcRenderer.invoke("agent:resolve-plan-review", conversationId, input),
    listRecoveries: () => ipcRenderer.invoke("agent:list-recoveries"),
    retryRecovery: (id: string) => ipcRenderer.invoke("agent:retry-recovery", id),
    discardRecovery: (id: string) => ipcRenderer.invoke("agent:discard-recovery", id),
    retryRuntime: (conversationId) => ipcRenderer.invoke("agent:retry-runtime", conversationId),
    onEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
      ipcRenderer.on("agent:event", handler);
      return () => ipcRenderer.removeListener("agent:event", handler);
    },
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);
