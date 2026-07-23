import { CheckCircle2, Package, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { NewChatView } from "./components/NewChatView";
import { SettingsView } from "./components/SettingsView";
import { modelOptions } from "./data";
import type { AppView, ChatTurn, Project, SettingsSection, Theme } from "./types";

type Notice = {
  title: string;
  message: string;
  type: "success" | "info";
};

function getInitialTheme(): Theme {
  const saved = window.localStorage.getItem("pi-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function App() {
  const [view, setView] = useState<AppView>("chat");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [project, setProject] = useState<Project | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>("approval-flow");
  const [modelId, setModelId] = useState(modelOptions[0].id);
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

  const title = useMemo(() => (view === "settings" ? "设置" : project?.name ?? "新建对话"), [project, view]);

  function startNewChat() {
    setView("chat");
    setProject(null);
    setSelectedConversationId(null);
    setPrompt("");
    setTurns([]);
  }

  function selectConversation(conversationId: string, nextProject?: Project) {
    setView("chat");
    setSelectedConversationId(conversationId);
    setProject(nextProject ?? null);
    setPrompt("");
    setTurns([]);
  }

  function submitPrompt() {
    const question = prompt.trim();
    if (!question) return;
    const answer = project
      ? `我会先在 ${project.path} 内分析与问题相关的文件，确认实现路径后再开始修改。工作区外访问和敏感命令仍会单独向你申请。`
      : "我会先梳理问题的目标和约束，再给出清晰的分析与可执行建议。如果任务需要读取本地项目，可以随时为这条对话选择工作目录。";
    setTurns((current) => [
      ...current,
      { id: `${Date.now()}-${current.length}`, question, answer },
    ]);
    setPrompt("");
  }

  function retryTurn(turnId: string) {
    setTurns((current) => current.map((turn) => (
      turn.id === turnId
        ? {
            ...turn,
            answer: project
              ? `我重新整理了执行思路：先限定在 ${project.path} 内定位相关模块，再按影响范围逐步修改并验证结果。任何越界访问都会先向你确认。`
              : "我重新组织了答案：先明确目标与限制，再给出分步骤的建议和可验证的下一步。需要本地代码上下文时，可以为当前对话选择工作目录。",
          }
        : turn
    )));
  }

  return (
    <div className="desktop-page">
      <section className="desktop-window" aria-label="Pi Desktop 前端预览">
        <header className="window-bar">
          <span className="traffic-lights" aria-hidden="true"><i /><i /><i /></span>
          <span className="window-title">Pi Desktop — {title}</span>
          <span className="window-shortcut">⌘ K</span>
        </header>

        {view === "chat" ? (
          <div className="chat-shell">
            <ConversationSidebar
              selectedConversationId={selectedConversationId}
              onSelectConversation={selectConversation}
              onNewChat={startNewChat}
              onOpenSettings={() => { setSettingsSection("models"); setView("settings"); }}
              onOpenPlugins={() => setNotice({ title: "插件中心", message: "插件页面已预留入口，可在接入插件协议后扩展。", type: "info" })}
              onOpenPet={() => setNotice({ title: "Pi 宠物", message: "陪伴模式将在后续版本接入。", type: "info" })}
            />
            <main className="chat-main">
              <NewChatView
                project={project}
                turns={turns}
                modelId={modelId}
                prompt={prompt}
                onPromptChange={setPrompt}
                onProjectChange={setProject}
                onModelChange={setModelId}
                onSubmit={submitPrompt}
                onRetry={retryTurn}
              />
            </main>
          </div>
        ) : (
          <SettingsView
            activeSection={settingsSection}
            modelId={modelId}
            theme={theme}
            onBack={() => setView("chat")}
            onSectionChange={setSettingsSection}
            onModelChange={setModelId}
            onThemeChange={setTheme}
            onSaved={() => setNotice({ title: "设置已保存", message: "模型配置已保存在本机。", type: "success" })}
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
