import { CheckCircle2, Package, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { NewChatView } from "./components/NewChatView";
import { SettingsView } from "./components/SettingsView";
import type { AgentEvent, AuthEvent, ContextUsageInfo, ConversationHistoryItem, ModelMetadataOverride, ModelSettings, PermissionRuntime, PermissionSettings, ProviderCatalogEntry, SaveModelSettings } from "./contracts";
import { appendMessageDelta } from "./conversation-activity";
import { normalizeContextUsage, normalizeHistoryTurn } from "./conversation-history";
import { isPrimaryShortcut, shortcutLabel } from "./keyboard";
import { useI18n } from "./i18n";
import { mergeAnswerUsage } from "./response-usage";
import type { AppView, AuthFlowState, ChatTurn, Conversation, Project, SettingsSection, Theme } from "./types";

type Notice = {
  title: string;
  message: string;
  type: "success" | "info";
};

const initialModelSettings: ModelSettings = {
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  modelId: "claude-sonnet-4-6",
  thinkingLevel: "medium",
  hasApiKey: false,
  configuredProviders: [],
  credentials: [],
};

const initialPermissionRuntime: PermissionRuntime = {
  mode: "balanced",
  sandbox: "unavailable",
  platform: "unknown",
};

function getInitialTheme(): Theme {
  const saved = window.localStorage.getItem("pi-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function eventError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function historyTimestamp(timestamp: string, locale: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function historyConversation(item: ConversationHistoryItem, t: (message: string) => string, locale: string): Conversation {
  return {
    id: item.id,
    title: item.title,
    subtitle: item.project?.name ?? t("普通对话"),
    updatedAt: historyTimestamp(item.updatedAt, locale),
  };
}

function applyAgentEvent(turns: ChatTurn[], event: AgentEvent): ChatTurn[] {
  let targetIndex = turns.findIndex((turn) => turn.runId === event.runId);
  if (targetIndex < 0) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index].status === "running" && !turns[index].runId) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex < 0) return turns;

  return turns.map((turn, index) => {
    if (index !== targetIndex) return turn;
    const current = turn.runId ? turn : { ...turn, runId: event.runId };

    switch (event.type) {
      case "run.started":
        return current;
      case "message.delta": {
        return {
          ...current,
          answer: current.answer + event.text,
          activities: appendMessageDelta(current.activities, event.text),
        };
      }
      case "thinking.delta": {
        const last = current.activities.at(-1);
        const activities = last?.type === "thinking"
          ? current.activities.map((item, itemIndex) => itemIndex === current.activities.length - 1 && item.type === "thinking"
            ? { ...item, text: item.text + event.text }
            : item)
          : [...current.activities, { id: `thinking-${current.activities.length}`, type: "thinking" as const, text: event.text }];
        return { ...current, activities };
      }
      case "tool.started":
        return {
          ...current,
          activities: [...current.activities, {
            id: event.callId,
            type: "tool",
            name: event.name,
            args: event.args,
            output: "",
            status: "running",
          }],
        };
      case "tool.updated":
        return {
          ...current,
          activities: current.activities.map((item) => item.type === "tool" && item.id === event.callId
            ? { ...item, output: event.output }
            : item),
        };
      case "tool.completed":
        return {
          ...current,
          activities: current.activities.map((item) => item.type === "tool" && item.id === event.callId
            ? { ...item, output: event.output, status: event.isError ? "error" : "success" }
            : item),
        };
      case "question.requested":
        return {
          ...current,
          activities: [...current.activities.filter((item) => !(item.type === "question" && item.id === event.callId)), {
            id: event.callId,
            type: "question",
            question: event.question,
            options: event.options,
            status: "pending",
          }],
        };
      case "response.usage":
        return { ...current, usage: mergeAnswerUsage(current.usage, event.usage) };
      case "context.updated":
        return current;
      case "agent.event":
        // Raw SDK events are acknowledged here but intentionally stay out of the user-facing UI.
        return current;
      case "run.completed":
        return current.status === "stopped" ? current : { ...current, status: "completed" };
      case "run.stopped":
        return { ...current, status: "stopped" };
      case "run.error":
        return current.status === "stopped" ? current : { ...current, status: "error", error: event.message };
    }
  });
}

function applyAuthEvent(current: AuthFlowState | null, event: AuthEvent, t: (message: string) => string): AuthFlowState | null {
  if (event.type === "auth.started") return { loginId: event.loginId, providerId: event.providerId, status: "running" };
  if (!current || current.loginId !== event.loginId) return current;
  switch (event.type) {
    case "auth.url":
      return { ...current, url: event.url, message: event.instructions ?? t("请在浏览器中完成登录。") };
    case "auth.device-code":
      return { ...current, deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds }, message: t("请在浏览器中输入设备码。") };
    case "auth.progress":
      return { ...current, message: event.message };
    case "auth.prompt":
      return { ...current, prompt: event.prompt };
    case "auth.prompt-cancelled":
      return current.prompt?.requestId === event.requestId ? { ...current, prompt: undefined } : current;
    case "auth.error":
      return { ...current, status: "error", prompt: undefined, message: event.message };
    case "auth.completed":
    case "auth.cancelled":
      return null;
  }
}

export function App() {
  const { language, locale, t } = useI18n();
  const [view, setView] = useState<AppView>("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [project, setProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversationTurns, setConversationTurns] = useState<Record<string, ChatTurn[]>>({});
  const [conversationContexts, setConversationContexts] = useState<Record<string, ContextUsageInfo | undefined>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchRequest, setSearchRequest] = useState(0);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettings>(initialModelSettings);
  const [permissionRuntime, setPermissionRuntime] = useState<PermissionRuntime>(initialPermissionRuntime);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo>();
  const [authFlow, setAuthFlow] = useState<AuthFlowState | null>(null);
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("pi-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!selectedConversationId) return;
    setConversationTurns((current) => current[selectedConversationId] === turns
      ? current
      : { ...current, [selectedConversationId]: turns });
  }, [selectedConversationId, turns]);

  useEffect(() => {
    void refreshModelSettings();
    void refreshPermissionRuntime();
    void refreshProviderCatalog(t("无法读取模型目录"));
    void refreshConversationHistory();
    const unsubscribeAgent = window.piDesktop?.agent.onEvent((event) => {
      if (event.type === "context.updated") setContextUsage(event.usage);
      setTurns((current) => applyAgentEvent(current, event));
      if (event.type === "run.completed" || event.type === "run.error" || event.type === "run.stopped") {
        void refreshConversationHistory();
      }
    });
    const unsubscribeAuth = window.piDesktop?.auth?.onEvent((event) => {
      setAuthFlow((current) => applyAuthEvent(current, event, t));
      if (event.type === "auth.completed") {
        void refreshModelSettings();
        void refreshProviderCatalog(t("模型目录刷新失败"));
        setNotice({ title: t("登录成功"), message: t("{provider} 的 OAuth 凭据已安全保存。", { provider: event.providerId }), type: "success" });
      } else if (event.type === "auth.error") {
        setNotice({ title: t("登录失败"), message: event.message, type: "info" });
      }
    });
    return () => {
      unsubscribeAgent?.();
      unsubscribeAuth?.();
    };
  }, [language]);

  async function refreshModelSettings() {
    await window.piDesktop?.settings.get().then(setModelSettings).catch((error: unknown) => {
      setNotice({ title: t("无法读取模型设置"), message: eventError(error), type: "info" });
    });
  }

  async function refreshPermissionRuntime() {
    await window.piDesktop?.permissions?.get().then(setPermissionRuntime).catch((error: unknown) => {
      setNotice({ title: t("无法读取权限设置"), message: eventError(error), type: "info" });
    });
  }

  async function refreshProviderCatalog(errorTitle: string) {
    if (!window.piDesktop) return;
    try {
      setProviderCatalog(await window.piDesktop.settings.catalog());
    } catch (error) {
      setNotice({ title: errorTitle, message: eventError(error), type: "info" });
    }
  }

  async function refreshConversationHistory() {
    if (!window.piDesktop || typeof window.piDesktop.agent.listConversations !== "function") return;
    try {
      const history = await window.piDesktop.agent.listConversations();
      setConversations(history.filter((item) => !item.project).map((item) => historyConversation(item, t, locale)));
      const grouped = new Map<string, Project>();
      for (const item of history) {
        if (!item.project) continue;
        const existing = grouped.get(item.project.id);
        const conversation = historyConversation(item, t, locale);
        if (existing) existing.conversations.push(conversation);
        else grouped.set(item.project.id, { ...item.project, conversations: [conversation] });
      }
      setProjects([...grouped.values()]);
    } catch (error) {
      setNotice({ title: t("无法读取会话历史"), message: eventError(error), type: "info" });
    }
  }

  const title = useMemo(() => (view === "settings" ? t("设置") : project?.name ?? t("新建对话")), [project, t, view]);
  const isRunning = turns.some((turn) => turn.status === "running");
  const configuredModelProviders = useMemo(() => {
    const configured = new Set(modelSettings.configuredProviders);
    const currentProvider = providerCatalog.find((provider) => provider.id === modelSettings.provider);
    if (currentProvider?.kind === "compatible") configured.add(currentProvider.id);
    return providerCatalog.filter((provider) => configured.has(provider.id) && provider.models.length > 0);
  }, [modelSettings.configuredProviders, modelSettings.provider, providerCatalog]);
  const selectedContextWindow = providerCatalog.find((provider) => provider.id === modelSettings.provider)
    ?.models.find((model) => model.id === modelSettings.modelId)?.contextWindow ?? 0;
  const displayedContextUsage = contextUsage ?? (selectedContextWindow > 0
    ? { tokens: turns.length === 0 ? 0 : null, contextWindow: selectedContextWindow, percent: turns.length === 0 ? 0 : null }
    : undefined);

  async function resetConversation() {
    if (isRunning) await window.piDesktop?.agent.abort();
    await window.piDesktop?.agent.reset();
    setTurns([]);
    setPrompt("");
  }

  function startNewChat() {
    if (selectedConversationId) {
      setConversationContexts((current) => ({ ...current, [selectedConversationId]: contextUsage }));
    }
    setView("chat");
    setProject(null);
    setSelectedConversationId(null);
    setContextUsage(undefined);
    void resetConversation();
  }

  function startProjectChat(nextProject: Project) {
    if (selectedConversationId) {
      setConversationContexts((current) => ({ ...current, [selectedConversationId]: contextUsage }));
    }
    setView("chat");
    setProject(projects.find((entry) => entry.id === nextProject.id) ?? nextProject);
    setSelectedConversationId(null);
    setContextUsage(undefined);
    void resetConversation();
  }

  async function renameConversation(conversationId: string, title: string, scopeProject?: Project) {
    if (!window.piDesktop?.agent.renameConversation) {
      setNotice({ title: t("无法重命名会话"), message: t("请完全退出并重新启动新版 Pi Desktop。"), type: "info" });
      throw new Error("会话重命名接口不可用。");
    }
    try {
      await window.piDesktop.agent.renameConversation(conversationId, title);
      const rename = (conversation: Conversation) => conversation.id === conversationId ? { ...conversation, title } : conversation;
      if (scopeProject) {
        setProjects((current) => current.map((entry) => entry.id === scopeProject.id
          ? { ...entry, conversations: entry.conversations.map(rename) }
          : entry));
        setProject((current) => current?.id === scopeProject.id
          ? { ...current, conversations: current.conversations.map(rename) }
          : current);
      } else {
        setConversations((current) => current.map(rename));
      }
      setNotice({ title: t("会话已重命名"), message: title, type: "success" });
    } catch (error) {
      setNotice({ title: t("无法重命名会话"), message: eventError(error), type: "info" });
      throw error;
    }
  }

  async function deleteConversation(conversationId: string, scopeProject?: Project) {
    if (!window.piDesktop?.agent.deleteConversation) {
      setNotice({ title: t("无法删除会话"), message: t("请完全退出并重新启动新版 Pi Desktop。"), type: "info" });
      return;
    }
    try {
      await window.piDesktop.agent.deleteConversation(conversationId);
      const remove = (conversation: Conversation) => conversation.id !== conversationId;
      setConversations((current) => current.filter(remove));
      setProjects((current) => current.map((entry) => ({ ...entry, conversations: entry.conversations.filter(remove) })));
      setProject((current) => current && scopeProject?.id === current.id
        ? { ...current, conversations: current.conversations.filter(remove) }
        : current);
      setConversationTurns((current) => {
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      setConversationContexts((current) => {
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      if (selectedConversationId === conversationId) {
        setSelectedConversationId(null);
        setTurns([]);
        setPrompt("");
        setContextUsage(undefined);
        if (!scopeProject) setProject(null);
      }
      setNotice({ title: t("会话已删除"), message: t("本地会话历史已删除。"), type: "success" });
    } catch (error) {
      setNotice({ title: t("无法删除会话"), message: eventError(error), type: "info" });
    }
  }

  function selectConversation(conversationId: string, nextProject?: Project) {
    void openConversation(conversationId, nextProject);
  }

  async function openConversation(conversationId: string, nextProject?: Project) {
    if (conversationId === selectedConversationId) return;
    if (selectedConversationId) {
      setConversationContexts((current) => ({ ...current, [selectedConversationId]: contextUsage }));
    }
    if (isRunning) await window.piDesktop?.agent.abort();
    await window.piDesktop?.agent.reset();
    setView("chat");
    setSelectedConversationId(conversationId);
    setProject(nextProject ? projects.find((entry) => entry.id === nextProject.id) ?? nextProject : null);
    setPrompt("");
    const cachedTurns = conversationTurns[conversationId];
    if (cachedTurns) {
      setTurns(cachedTurns);
      setContextUsage(conversationContexts[conversationId]);
      return;
    }
    if (!window.piDesktop || typeof window.piDesktop.agent.loadConversation !== "function") {
      setTurns([]);
      return;
    }
    try {
      const history = await window.piDesktop.agent.loadConversation(conversationId);
      const restoredTurns = Array.isArray(history.turns) ? history.turns.map(normalizeHistoryTurn) : [];
      const restoredContext = normalizeContextUsage(history.contextUsage);
      setConversationTurns((current) => ({ ...current, [conversationId]: restoredTurns }));
      setConversationContexts((current) => ({ ...current, [conversationId]: restoredContext }));
      setTurns(restoredTurns);
      setContextUsage(restoredContext);
    } catch (error) {
      setTurns([]);
      setNotice({ title: t("无法打开会话"), message: eventError(error), type: "info" });
    }
  }

  async function chooseWorkspace() {
    const selected = await window.piDesktop?.workspace.choose();
    if (!selected) return;
    const nextProject = {
      id: selected.path,
      name: selected.name,
      path: selected.path,
      conversations: projects.find((entry) => entry.id === selected.path)?.conversations ?? [],
    };
    setProjects((current) => current.some((entry) => entry.id === nextProject.id)
      ? current
      : [...current, nextProject]);
    setProject(nextProject);
  }

  function ensureConversation(question: string): string {
    if (selectedConversationId) return selectedConversationId;
    const conversationId = `conversation-${Date.now()}`;
    const normalizedTitle = question.trim().replace(/\s+/g, " ");
    const conversation: Conversation = {
      id: conversationId,
      title: normalizedTitle.length > 34 ? `${normalizedTitle.slice(0, 34)}…` : normalizedTitle,
      subtitle: project ? project.name : t("普通对话"),
      updatedAt: t("刚刚"),
    };
    setSelectedConversationId(conversationId);
    if (project) {
      setProjects((current) => {
        const existing = current.find((entry) => entry.id === project.id);
        if (existing) return current.map((entry) => entry.id === project.id
          ? { ...entry, conversations: [conversation, ...entry.conversations] }
          : entry);
        return [...current, { ...project, conversations: [conversation] }];
      });
      setProject((current) => current ? { ...current, conversations: [conversation, ...current.conversations] } : current);
    } else {
      setConversations((current) => [conversation, ...current]);
    }
    return conversationId;
  }

  async function sendQuestion(question: string) {
    if (!question.trim() || isRunning) return;
    const wasNewConversation = !selectedConversationId;
    const conversationId = ensureConversation(question);
    const id = `${Date.now()}-${turns.length}`;
    setTurns((current) => [...current, {
      id,
      question: question.trim(),
      answer: "",
      activities: [],
      status: "running",
    }]);
    setPrompt("");

    if (!window.piDesktop) {
      setTurns((current) => current.map((turn) => turn.id === id
        ? { ...turn, status: "error", error: "请通过 Electron 启动 Pi Desktop；浏览器预览无法访问本地 Agent。" }
        : turn));
      return;
    }
    try {
      const { runId } = await window.piDesktop.agent.send({ prompt: question.trim(), cwd: project?.path, conversationId });
      setTurns((current) => current.map((turn) => turn.id === id && !turn.runId ? { ...turn, runId } : turn));
    } catch (error) {
      setTurns((current) => current.map((turn) => turn.id === id
        ? { ...turn, status: "error", error: eventError(error) }
        : turn));
      if (wasNewConversation) {
        setSelectedConversationId((current) => current === conversationId ? null : current);
        setConversationTurns((current) => {
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
        void refreshConversationHistory();
      }
    }
  }

  function submitPrompt() {
    void sendQuestion(prompt);
  }

  function retryTurn(turnId: string) {
    const turn = turns.find((item) => item.id === turnId);
    if (turn) void sendQuestion(turn.question);
  }

  async function stopAgent() {
    await window.piDesktop?.agent.abort();
  }

  async function answerQuestion(turnId: string, callId: string, answer: string) {
    await window.piDesktop?.agent.answerQuestion(callId, answer);
    setTurns((current) => current.map((turn) => turn.id === turnId ? {
      ...turn,
      activities: turn.activities.map((activity) => activity.type === "question" && activity.id === callId
        ? { ...activity, answer, status: "answered" }
        : activity),
    } : turn));
  }

  async function saveModelSettings(input: SaveModelSettings) {
    if (!window.piDesktop) throw new Error("模型设置只能在 Electron 应用中保存。");
    const saved = await window.piDesktop.settings.save(input);
    setModelSettings(saved);
    void refreshProviderCatalog(t("模型目录刷新失败"));
    setNotice({ title: t("设置已保存"), message: t("模型配置已保存；API Key（如有）已加密存储。"), type: "success" });
  }

  async function savePermissionSettings(input: PermissionSettings) {
    if (!window.piDesktop?.permissions) throw new Error("权限设置只能在 Electron 应用中保存。");
    const saved = await window.piDesktop.permissions.save(input);
    setPermissionRuntime(saved);
    setNotice({
      title: t("权限模式已更新"),
      message: t(saved.mode === "balanced" ? "工作区内操作将自动执行，危险操作仍会询问。" : "Shell 与文件修改将在执行前确认。"),
      type: "success",
    });
  }

  async function discoverModels(input: SaveModelSettings) {
    if (!window.piDesktop) throw new Error("模型列表只能在 Electron 应用中获取。");
    if (typeof window.piDesktop.settings.discoverModels !== "function") {
      throw new Error("应用后台仍是旧版本。请完全退出 Pi Desktop 后重新启动，再点击“获取模型”。");
    }
    const models = await window.piDesktop.settings.discoverModels(input);
    setProviderCatalog((current) => current.map((provider) => provider.id === input.provider ? { ...provider, models } : provider));
    return models;
  }

  async function refreshModelMetadata() {
    if (!window.piDesktop?.settings.refreshMetadata) throw new Error("模型元信息同步需要重新启动新版 Pi Desktop。");
    const catalog = await window.piDesktop.settings.refreshMetadata();
    setProviderCatalog(catalog);
    return catalog;
  }

  async function saveModelMetadata(providerId: string, modelId: string, metadata: ModelMetadataOverride) {
    if (!window.piDesktop?.settings.saveMetadata) throw new Error("模型元信息编辑需要重新启动新版 Pi Desktop。");
    const catalog = await window.piDesktop.settings.saveMetadata(providerId, modelId, metadata);
    setProviderCatalog(catalog);
    return catalog;
  }

  async function resetModelMetadata(providerId: string, modelId: string) {
    if (!window.piDesktop?.settings.resetMetadata) throw new Error("模型元信息编辑需要重新启动新版 Pi Desktop。");
    const catalog = await window.piDesktop.settings.resetMetadata(providerId, modelId);
    setProviderCatalog(catalog);
    return catalog;
  }

  async function selectChatModel(providerId: string, modelId: string) {
    if (!window.piDesktop || isRunning) return;
    const provider = providerCatalog.find((entry) => entry.id === providerId);
    if (!provider) return;
    try {
      const startsNewConversation = turns.length > 0;
      const saved = await window.piDesktop.settings.save({
        provider: providerId,
        baseUrl: providerId === modelSettings.provider ? modelSettings.baseUrl : provider.baseUrl,
        modelId,
        thinkingLevel: modelSettings.thinkingLevel,
      });
      setModelSettings(saved);
      if (startsNewConversation) {
        setTurns([]);
        setPrompt("");
        setSelectedConversationId(null);
        setContextUsage(undefined);
      }
      setNotice({
        title: t("模型已切换"),
        message: `${provider.name} · ${modelId}${startsNewConversation ? t("；已开始新对话") : ""}`,
        type: "success",
      });
    } catch (error) {
      setNotice({ title: t("模型切换失败"), message: eventError(error), type: "info" });
    }
  }

  async function testModelSettings(input: SaveModelSettings) {
    if (!window.piDesktop) throw new Error("连接验证只能在 Electron 应用中运行。");
    const result = await window.piDesktop.settings.test(input);
    setNotice({ title: t("连接成功"), message: t("模型返回：{response}", { response: result.response }), type: "success" });
  }

  async function loginProvider(providerId: string) {
    if (!window.piDesktop?.auth) throw new Error("OAuth 模块尚未加载，请完全退出并重新启动 Pi Desktop。");
    await window.piDesktop.auth.login(providerId);
  }

  async function answerAuthPrompt(requestId: string, value: string) {
    if (!window.piDesktop?.auth) throw new Error("OAuth 模块尚未加载，请重新启动 Pi Desktop。");
    await window.piDesktop.auth.answer(requestId, value);
    setAuthFlow((current) => current?.prompt?.requestId === requestId ? { ...current, prompt: undefined } : current);
  }

  async function cancelAuth(loginId: string) {
    if (!window.piDesktop?.auth) throw new Error("OAuth 模块尚未加载，请重新启动 Pi Desktop。");
    await window.piDesktop.auth.cancel(loginId);
    setAuthFlow(null);
  }

  async function logoutProvider(providerId: string) {
    if (!window.piDesktop?.auth) throw new Error("OAuth 模块尚未加载，请重新启动 Pi Desktop。");
    await window.piDesktop.auth.logout(providerId);
    await refreshModelSettings();
    setNotice({ title: t("已退出登录"), message: t("{provider} 的已保存凭据已删除。", { provider: providerId }), type: "success" });
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (event.repeat) return;
      if (isPrimaryShortcut(event, "n")) {
        event.preventDefault();
        startNewChat();
      } else if (isPrimaryShortcut(event, "k")) {
        event.preventDefault();
        setView("chat");
        setSidebarCollapsed(false);
        setSearchRequest((current) => current + 1);
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [isRunning]);

  return (
    <div className="desktop-page">
      <section className="desktop-window" aria-label="Pi Desktop">
        <header className="window-bar">
          <span className="window-drag-spacer" aria-hidden="true" />
          <span className="window-title">Pi Desktop — {title}</span>
          <span className="window-shortcut" title={t("搜索对话或项目")}>{shortcutLabel("K")}</span>
        </header>

        {view === "chat" ? (
          <div className={`chat-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
            <ConversationSidebar
              collapsed={sidebarCollapsed}
              conversations={conversations}
              projects={projects}
              selectedConversationId={selectedConversationId}
              searchRequest={searchRequest}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
              onSelectConversation={selectConversation}
              onNewChat={startNewChat}
              onNewProjectChat={startProjectChat}
              onRenameConversation={renameConversation}
              onDeleteConversation={deleteConversation}
              conversationActionsDisabled={isRunning}
              onAddProject={() => void chooseWorkspace()}
              onOpenSettings={() => { setSettingsSection("models"); setView("settings"); }}
              onOpenPlugins={() => { setSettingsSection("plugins"); setView("settings"); }}
              onOpenPet={() => setNotice({ title: t("Pi 宠物"), message: t("陪伴模式将在后续版本接入。"), type: "info" })}
            />
            <main className="chat-main">
              <NewChatView
                project={project}
                turns={turns}
                modelId={modelSettings.modelId}
                modelProvider={modelSettings.provider}
                modelProviders={configuredModelProviders}
                contextUsage={displayedContextUsage}
                prompt={prompt}
                isRunning={isRunning}
                onPromptChange={setPrompt}
                onProjectChange={setProject}
                onChooseWorkspace={() => void chooseWorkspace()}
                onModelChange={(providerId, modelId) => void selectChatModel(providerId, modelId)}
                onSubmit={submitPrompt}
                onStop={() => void stopAgent()}
                onRetry={retryTurn}
                onAnswerQuestion={(turnId, callId, answer) => void answerQuestion(turnId, callId, answer)}
              />
            </main>
          </div>
        ) : (
          <SettingsView
            activeSection={settingsSection}
            settings={modelSettings}
            permissionRuntime={permissionRuntime}
            providerCatalog={providerCatalog}
            authFlow={authFlow}
            theme={theme}
            agentRunning={isRunning}
            onBack={() => setView("chat")}
            onSectionChange={setSettingsSection}
            onThemeChange={setTheme}
            onSave={saveModelSettings}
            onSavePermissions={savePermissionSettings}
            onDiscoverModels={discoverModels}
            onRefreshMetadata={refreshModelMetadata}
            onSaveMetadata={saveModelMetadata}
            onResetMetadata={resetModelMetadata}
            onTest={testModelSettings}
            onLogin={loginProvider}
            onAnswerAuthPrompt={answerAuthPrompt}
            onCancelAuth={cancelAuth}
            onLogout={logoutProvider}
            onDismissAuth={() => setAuthFlow(null)}
          />
        )}

        {notice && (
          <div className={`notice notice--${notice.type}`} role="status">
            <span className="notice-icon">{notice.type === "success" ? <CheckCircle2 size={17} /> : notice.title.includes(t("插件")) ? <Package size={17} /> : <Sparkles size={17} />}</span>
            <span><strong>{notice.title}</strong><small>{notice.message}</small></span>
            <button type="button" onClick={() => setNotice(null)} aria-label={t("关闭提示")}><X size={14} /></button>
          </div>
        )}
      </section>
    </div>
  );
}
