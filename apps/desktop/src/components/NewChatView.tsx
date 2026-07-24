import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowUp,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Copy,
  Folder,
  MessageCircleQuestion,
  Paperclip,
  Radio,
  RotateCcw,
  TerminalSquare,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { ChatActivity, ChatTurn, Project } from "../types";
import { BrandMark } from "./BrandMark";

type NewChatViewProps = {
  project: Project | null;
  turns: ChatTurn[];
  modelName: string;
  prompt: string;
  isRunning: boolean;
  onPromptChange: (value: string) => void;
  onProjectChange: (project: Project | null) => void;
  onChooseWorkspace: () => void;
  onSubmit: () => void;
  onStop: () => void;
  onRetry: (turnId: string) => void;
  onAnswerQuestion: (turnId: string, callId: string, answer: string) => void;
};

function formatData(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function ModelBadge({ name }: { name: string }) {
  return (
    <span className="composer-tool-button model-trigger" title={name}>
      <span>{name}</span>
    </span>
  );
}

function DirectoryMenu({
  project,
  compact = false,
  onProjectChange,
  onChooseWorkspace,
}: Pick<NewChatViewProps, "project" | "onProjectChange" | "onChooseWorkspace"> & { compact?: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={compact ? "composer-tool-button compact-directory-trigger" : "directory-trigger"} type="button">
          <Folder size={15} />
          <span>{compact ? project?.name ?? "普通对话" : project ? "更换目录" : "选择目录"}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content directory-menu" align="start" sideOffset={8}>
          <DropdownMenu.Item className="dropdown-item directory-item" onSelect={onChooseWorkspace}>
            <Folder size={15} />
            <span><strong>打开工作目录…</strong><code>由系统选择器授权目录</code></span>
          </DropdownMenu.Item>
          {project && (
            <DropdownMenu.Item className="dropdown-item directory-item" onSelect={() => onProjectChange(null)}>
              <span className="directory-empty">×</span>
              <span><strong>移除工作目录</strong><code>转为无本地文件访问的普通对话</code></span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SendControl({ isRunning, canSend, onStop }: { isRunning: boolean; canSend: boolean; onStop: () => void }) {
  if (isRunning) {
    return <button className="send-button stop-button" type="button" aria-label="停止 Agent" onClick={onStop}><CircleStop size={16} /></button>;
  }
  return <button className="send-button" type="submit" aria-label="发送" disabled={!canSend}><ArrowUp size={17} /></button>;
}

function InitialComposer(props: NewChatViewProps) {
  return (
    <section className="new-chat-view" aria-label="新建对话">
      <div className="composer-stage">
        <header className="composer-heading">
          <span className="orbit-mark"><BrandMark compact /><i /></span>
          <h1>{props.project ? `在 ${props.project.name} 中开始新对话` : "今天想一起做什么？"}</h1>
          <p>
            {props.project
              ? "Pi 将以该目录为边界读取文件、执行命令并追踪变更。"
              : "直接提问，或选择工作目录开始一个真实的 Agent 会话。"}
          </p>
        </header>

        <form className="composer-card" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
          <textarea
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            placeholder="描述你想分析、构建或修改的内容…"
            aria-label="对话内容"
          />
          <div className="composer-toolbar">
            <button className="composer-tool-button" type="button" aria-label="添加附件"><Paperclip size={15} /></button>
            <ModelBadge name={props.modelName} />
            <SendControl isRunning={props.isRunning} canSend={Boolean(props.prompt.trim())} onStop={props.onStop} />
          </div>
        </form>

        <div className="conversation-context">
          <DirectoryMenu project={props.project} onProjectChange={props.onProjectChange} onChooseWorkspace={props.onChooseWorkspace} />
          <span className="context-copy">
            <strong>{props.project ? props.project.path : "普通对话"}</strong>
            <small>{props.project ? `Pi 工具将相对 ${props.project.name} 运行` : "未关联工作目录，Pi 使用隔离的空目录"}</small>
          </span>
        </div>
        <p className="context-hint">命令和文件修改会在执行前询问，thinking 与工具过程会实时展示。</p>
      </div>
    </section>
  );
}

function ThinkingActivity({ activity }: { activity: Extract<ChatActivity, { type: "thinking" }> }) {
  return (
    <Collapsible.Root className="agent-activity thinking-activity" defaultOpen>
      <Collapsible.Trigger className="activity-trigger">
        <BrainCircuit size={14} />
        <span>Thinking</span>
        <ChevronDown size={13} className="activity-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Content className="thinking-content">{activity.text}</Collapsible.Content>
    </Collapsible.Root>
  );
}

function ToolActivity({ activity }: { activity: Extract<ChatActivity, { type: "tool" }> }) {
  const isSubagent = activity.name === "spawn_subagent";
  const Icon = isSubagent ? Users : TerminalSquare;
  const title = isSubagent ? "子 Agent" : activity.name;
  return (
    <Collapsible.Root className={`agent-activity tool-activity tool-activity--${activity.status}`} defaultOpen={isSubagent}>
      <Collapsible.Trigger className="activity-trigger">
        <Icon size={14} />
        <span>{title}</span>
        <small>{activity.status === "running" ? "运行中" : activity.status === "success" ? "完成" : "失败"}</small>
        {activity.status === "running" ? <i className="activity-spinner" /> : activity.status === "success" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        <ChevronDown size={13} className="activity-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Content className="tool-content">
        <div><span>输入</span><pre>{formatData(activity.args)}</pre></div>
        {(activity.output || activity.status !== "running") && <div><span>输出</span><pre>{activity.output || "工具未返回文本"}</pre></div>}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function QuestionActivity({
  turnId,
  activity,
  onAnswer,
}: {
  turnId: string;
  activity: Extract<ChatActivity, { type: "question" }>;
  onAnswer: NewChatViewProps["onAnswerQuestion"];
}) {
  const [customAnswer, setCustomAnswer] = useState("");
  return (
    <section className={`agent-activity question-activity ${activity.status === "answered" ? "is-answered" : ""}`}>
      <header><MessageCircleQuestion size={15} /><strong>Pi 需要你的回答</strong></header>
      <p>{activity.question}</p>
      {activity.status === "answered" ? (
        <div className="question-answer"><Check size={13} />{activity.answer}</div>
      ) : (
        <>
          {activity.options.length > 0 && (
            <div className="question-options">
              {activity.options.map((option) => (
                <button key={option.label} type="button" onClick={() => onAnswer(turnId, activity.id, option.label)}>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </button>
              ))}
            </div>
          )}
          <form className="question-custom-answer" onSubmit={(event) => {
            event.preventDefault();
            if (customAnswer.trim()) onAnswer(turnId, activity.id, customAnswer.trim());
          }}>
            <input value={customAnswer} onChange={(event) => setCustomAnswer(event.target.value)} placeholder="输入其他回答…" />
            <button type="submit" disabled={!customAnswer.trim()}>提交</button>
          </form>
        </>
      )}
    </section>
  );
}

function eventSubtype(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const assistantEvent = (payload as { assistantMessageEvent?: unknown }).assistantMessageEvent;
  if (!assistantEvent || typeof assistantEvent !== "object") return undefined;
  const type = (assistantEvent as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function AgentEventTrace({ trace }: Pick<ChatTurn, "trace">) {
  const counts = trace.reduce<Record<string, number>>((current, event) => {
    current[event.eventType] = (current[event.eventType] ?? 0) + 1;
    return current;
  }, {});
  return (
    <Collapsible.Root className="agent-activity event-trace">
      <Collapsible.Trigger className="activity-trigger">
        <Radio size={14} />
        <span>Pi 事件流</span>
        <small>{trace.length} 个事件 · {Object.keys(counts).length} 类</small>
        <ChevronDown size={13} className="activity-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Content className="event-trace-content">
        <div className="event-type-summary">
          {Object.entries(counts).map(([type, count]) => <span key={type}>{type} <b>{count}</b></span>)}
        </div>
        <ol>
          {trace.map((event) => {
            const subtype = eventSubtype(event.payload);
            return (
              <li key={event.sequence}>
                <header><code>#{event.sequence}</code><strong>{event.eventType}{subtype ? ` · ${subtype}` : ""}</strong><time>{new Date(event.timestamp).toLocaleTimeString()}</time></header>
                <pre>{formatData(event.payload)}</pre>
              </li>
            );
          })}
        </ol>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ConversationTurn({ turn, onRetry, onAnswerQuestion }: {
  turn: ChatTurn;
  onRetry: (turnId: string) => void;
  onAnswerQuestion: NewChatViewProps["onAnswerQuestion"];
}) {
  const [copied, setCopied] = useState(false);

  async function copyQuestion() {
    await navigator.clipboard.writeText(turn.question);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <article className="qa-pair">
      <section className="qa-message qa-question" aria-label="用户消息">
        <div className="message-bubble-stack message-bubble-stack--user">
          <div className="question-content">{turn.question}</div>
          <div className="message-actions">
            <button type="button" onClick={() => void copyQuestion()} aria-label="复制用户输入">
              {copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? "已复制" : "复制"}</span>
            </button>
            <button type="button" onClick={() => onRetry(turn.id)} disabled={turn.status === "running"}>
              <RotateCcw size={13} /><span>重试</span>
            </button>
          </div>
        </div>
      </section>
      <section className="qa-message qa-answer" aria-label="Agent 回答">
        <div className="agent-response">
          {turn.activities.map((activity) => activity.type === "thinking"
            ? <ThinkingActivity key={activity.id} activity={activity} />
            : activity.type === "tool"
              ? <ToolActivity key={activity.id} activity={activity} />
              : <QuestionActivity key={`question-${activity.id}`} turnId={turn.id} activity={activity} onAnswer={onAnswerQuestion} />)}
          {turn.trace.length > 0 && <AgentEventTrace trace={turn.trace} />}
          {turn.answer && <div className="answer-content"><p>{turn.answer}</p></div>}
          {turn.status === "running" && !turn.answer && turn.activities.length === 0 && <div className="agent-working"><i />Pi 正在思考…</div>}
          {turn.status === "error" && <div className="agent-error"><XCircle size={14} />{turn.error}</div>}
          {turn.status === "stopped" && <div className="agent-stopped">任务已停止</div>}
        </div>
      </section>
    </article>
  );
}

function ActiveConversation(props: NewChatViewProps) {
  return (
    <section className="active-conversation" aria-label="当前对话">
      <div className="conversation-scroll" aria-live="polite">
        <div className="conversation-turns">
          {props.turns.map((turn) => <ConversationTurn key={turn.id} turn={turn} onRetry={props.onRetry} onAnswerQuestion={props.onAnswerQuestion} />)}
        </div>
      </div>
      <footer className="conversation-dock">
        <form className="compact-composer" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
          <textarea
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            placeholder={props.isRunning ? "Agent 执行中，可先停止当前任务…" : "继续给 Pi 指令…"}
            aria-label="继续对话"
            disabled={props.isRunning}
          />
          <div className="compact-composer-toolbar">
            <button className="composer-tool-button" type="button" aria-label="添加附件"><Paperclip size={15} /></button>
            <ModelBadge name={props.modelName} />
            <DirectoryMenu compact project={props.project} onProjectChange={props.onProjectChange} onChooseWorkspace={props.onChooseWorkspace} />
            <SendControl isRunning={props.isRunning} canSend={Boolean(props.prompt.trim())} onStop={props.onStop} />
          </div>
        </form>
        <p className="dock-context">
          {props.project ? <><Folder size={12} /><code>{props.project.path}</code><span>修改类工具执行前需授权</span></> : <><span>普通对话</span><span>隔离目录 · 不访问本地项目</span></>}
        </p>
      </footer>
    </section>
  );
}

export function NewChatView(props: NewChatViewProps) {
  return props.turns.length ? <ActiveConversation {...props} /> : <InitialComposer {...props} />;
}
