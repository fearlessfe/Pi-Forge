import { CheckCircle2, Package, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { NewChatView } from "./components/NewChatView";
import { SettingsView } from "./components/SettingsView";
import type { AgentEvent, AuthEvent, ModelSettings, ProviderCatalogEntry, SaveModelSettings } from "./contracts";
import type { AppView, AuthFlowState, ChatTurn, Project, SettingsSection, Theme } from "./types";

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

function getInitialTheme(): Theme {
  const saved = window.localStorage.getItem("pi-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function eventError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
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
      case "message.delta":
        return { ...current, answer: current.answer + event.text };
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
      case "agent.event":
        return { ...current, trace: [...current.trace, event.event] };
      case "run.completed":
        return current.status === "stopped" ? current : { ...current, status: "completed" };
      case "run.stopped":
        return { ...current, status: "stopped" };
      case "run.error":
        return current.status === "stopped" ? current : { ...current, status: "error", error: event.message };
    }
  });
}

function applyAuthEvent(current: AuthFlowState | null, event: AuthEvent): AuthFlowState | null {
  if (event.type === "auth.started") return { loginId: event.loginId, providerId: event.providerId, status: "running" };
  if (!current || current.loginId !== event.loginId) return current;
  switch (event.type) {
    case "auth.url":
      return { ...current, url: event.url, message: event.instructions ?? "请在浏览器中完成登录。" };
    case "auth.device-code":
      return { ...current, deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds }, message: "请在浏览器中输入设备码。" };
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
  const [view, setView] = useState<AppView>("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [project, setProject] = useState<Project | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettings>(initialModelSettings);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>([]);
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
    void refreshModelSettings();
    void window.piDesktop?.settings.catalog().then(setProviderCatalog).catch((error: unknown) => {
      setNotice({ title: "无法读取模型目录", message: eventError(error), type: "info" });
    });
    const unsubscribeAgent = window.piDesktop?.agent.onEvent((event) => setTurns((current) => applyAgentEvent(current, event)));
    const unsubscribeAuth = window.piDesktop?.auth?.onEvent((event) => {
      setAuthFlow((current) => applyAuthEvent(current, event));
      if (event.type === "auth.completed") {
        void refreshModelSettings();
        void window.piDesktop?.settings.catalog().then(setProviderCatalog).catch((error: unknown) => {
          setNotice({ title: "模型目录刷新失败", message: eventError(error), type: "info" });
        });
        setNotice({ title: "登录成功", message: `${event.providerId} 的 OAuth 凭据已安全保存。`, type: "success" });
      } else if (event.type === "auth.error") {
        setNotice({ title: "登录失败", message: event.message, type: "info" });
      }
    });
    return () => {
      unsubscribeAgent?.();
      unsubscribeAuth?.();
    };
  }, []);

  async function refreshModelSettings() {
    await window.piDesktop?.settings.get().then(setModelSettings).catch((error: unknown) => {
      setNotice({ title: "无法读取模型设置", message: eventError(error), type: "info" });
    });
  }

  const title = useMemo(() => (view === "settings" ? "设置" : project?.name ?? "新建对话"), [project, view]);
  const isRunning = turns.some((turn) => turn.status === "running");

  async function resetConversation() {
    if (isRunning) await window.piDesktop?.agent.abort();
    await window.piDesktop?.agent.reset();
    setTurns([]);
    setPrompt("");
  }

  function startNewChat() {
    setView("chat");
    setProject(null);
    setSelectedConversationId(null);
    void resetConversation();
  }

  function selectConversation(conversationId: string, nextProject?: Project) {
    setView("chat");
    setSelectedConversationId(conversationId);
    setProject(nextProject ?? null);
    void resetConversation();
  }

  async function chooseWorkspace() {
    const selected = await window.piDesktop?.workspace.choose();
    if (!selected) return;
    setProject({
      id: selected.path,
      name: selected.name,
      path: selected.path,
      conversations: [],
    });
  }

  async function sendQuestion(question: string) {
    if (!question.trim() || isRunning) return;
    const id = `${Date.now()}-${turns.length}`;
    setTurns((current) => [...current, {
      id,
      question: question.trim(),
      answer: "",
      activities: [],
      trace: [],
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
      const { runId } = await window.piDesktop.agent.send({ prompt: question.trim(), cwd: project?.path });
      setTurns((current) => current.map((turn) => turn.id === id && !turn.runId ? { ...turn, runId } : turn));
    } catch (error) {
      setTurns((current) => current.map((turn) => turn.id === id
        ? { ...turn, status: "error", error: eventError(error) }
        : turn));
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
    setNotice({ title: "设置已保存", message: "模型配置已保存；API Key（如有）已加密存储。", type: "success" });
  }

  async function testModelSettings(input: SaveModelSettings) {
    if (!window.piDesktop) throw new Error("连接验证只能在 Electron 应用中运行。");
    const result = await window.piDesktop.settings.test(input);
    setNotice({ title: "连接成功", message: `模型返回：${result.response}`, type: "success" });
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
    setNotice({ title: "已退出登录", message: `${providerId} 的已保存凭据已删除。`, type: "success" });
  }

  return (
    <div className="desktop-page">
      <section className="desktop-window" aria-label="Pi Desktop">
        <header className="window-bar">
          <span className="window-drag-spacer" aria-hidden="true" />
          <span className="window-title">Pi Desktop — {title}</span>
          <span className="window-shortcut">⌘ K</span>
        </header>

        {view === "chat" ? (
          <div className={`chat-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
            <ConversationSidebar
              collapsed={sidebarCollapsed}
              conversations={[]}
              projects={project ? [project] : []}
              selectedConversationId={selectedConversationId}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
              onSelectConversation={selectConversation}
              onNewChat={startNewChat}
              onAddProject={() => void chooseWorkspace()}
              onOpenSettings={() => { setSettingsSection("models"); setView("settings"); }}
              onOpenPlugins={() => { setSettingsSection("plugins"); setView("settings"); }}
              onOpenPet={() => setNotice({ title: "Pi 宠物", message: "陪伴模式将在后续版本接入。", type: "info" })}
            />
            <main className="chat-main">
              <NewChatView
                project={project}
                turns={turns}
                modelName={modelSettings.modelId}
                prompt={prompt}
                isRunning={isRunning}
                onPromptChange={setPrompt}
                onProjectChange={setProject}
                onChooseWorkspace={() => void chooseWorkspace()}
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
            providerCatalog={providerCatalog}
            authFlow={authFlow}
            theme={theme}
            agentRunning={isRunning}
            onBack={() => setView("chat")}
            onSectionChange={setSettingsSection}
            onThemeChange={setTheme}
            onSave={saveModelSettings}
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
            <span className="notice-icon">{notice.type === "success" ? <CheckCircle2 size={17} /> : notice.title.includes("插件") ? <Package size={17} /> : <Sparkles size={17} />}</span>
            <span><strong>{notice.title}</strong><small>{notice.message}</small></span>
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={14} /></button>
          </div>
        )}
      </section>
    </div>
  );
}
