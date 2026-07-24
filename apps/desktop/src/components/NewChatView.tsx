import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
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
  RotateCcw,
  TerminalSquare,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { ContextUsageInfo, ProviderCatalogEntry, ProviderId, ResponseUsage } from "../contracts";
import { normalizeVisibleActivities } from "../conversation-activity";
import { shouldSubmitOnEnter } from "../keyboard";
import { useI18n } from "../i18n";
import type { ChatActivity, ChatTurn, Project } from "../types";
import { BrandMark } from "./BrandMark";

type NewChatViewProps = {
  project: Project | null;
  turns: ChatTurn[];
  modelId: string;
  modelProvider: ProviderId;
  modelProviders: ProviderCatalogEntry[];
  contextUsage?: ContextUsageInfo;
  prompt: string;
  isRunning: boolean;
  onPromptChange: (value: string) => void;
  onProjectChange: (project: Project | null) => void;
  onChooseWorkspace: () => void;
  onModelChange: (provider: ProviderId, modelId: string) => void;
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

function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.000";
  return `$${cost < 0.001 ? cost.toFixed(6) : cost.toFixed(4)}`;
}

function ContextIndicator({ usage }: { usage?: ContextUsageInfo }) {
  const { t, locale } = useI18n();
  if (!usage || usage.contextWindow <= 0) return null;
  const percent = usage.percent === null ? null : Math.min(100, Math.max(0, usage.percent));
  const tone = percent !== null && percent >= 90 ? "is-critical" : percent !== null && percent >= 70 ? "is-warning" : "";
  const title = usage.tokens === null
    ? t("上下文刚完成压缩，将在模型下次响应后更新；上限 {limit} tokens", { limit: usage.contextWindow.toLocaleString(locale) })
    : t("当前上下文 {used} / {limit} tokens", { used: usage.tokens.toLocaleString(locale), limit: usage.contextWindow.toLocaleString(locale) });
  return (
    <span className={`context-indicator ${tone}`} title={title}>
      <span>{t("上下文")}</span>
      <strong>{usage.tokens === null ? "?" : formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}</strong>
      <progress max={100} value={percent ?? 0} aria-label={t("上下文使用比例")} />
      <em>{percent === null ? t("待更新") : `${percent.toFixed(0)}%`}</em>
    </span>
  );
}

function ResponseUsageLine({ usage }: { usage: ResponseUsage }) {
  const { t, locale } = useI18n();
  const model = usage.responseModel || usage.model;
  const cache = usage.cacheReadTokens + usage.cacheWriteTokens;
  const requestSummary = usage.requestCount > 1
    ? t("本回答共 {count} 次模型请求；token 显示最终请求，费用为全部请求合计", { count: usage.requestCount })
    : t("本回答共 1 次模型请求");
  return (
    <footer className="response-usage" title={`${t("最终请求")}：${t("输入")} ${usage.inputTokens.toLocaleString(locale)} · ${t("输出")} ${usage.outputTokens.toLocaleString(locale)} · ${t("缓存")} ${cache.toLocaleString(locale)} · ${t("总计")} ${usage.totalTokens.toLocaleString(locale)} tokens · ${requestSummary} · ${t("费用按模型目录单价估算")}`}>
      <span>{usage.provider}</span><strong>{model}</strong><i />
      <span>↑ {formatTokens(usage.inputTokens)}</span><span>↓ {formatTokens(usage.outputTokens)}</span>
      {cache > 0 && <span>{t("缓存")} {formatTokens(cache)}</span>}
      <span>{formatCost(usage.cost)}</span>
    </footer>
  );
}

function modelValue(provider: ProviderId, modelId: string) {
  return JSON.stringify([provider, modelId]);
}

function ModelSelector({
  provider,
  modelId,
  providers,
  disabled,
  onChange,
}: {
  provider: ProviderId;
  modelId: string;
  providers: ProviderCatalogEntry[];
  disabled: boolean;
  onChange: (provider: ProviderId, modelId: string) => void;
}) {
  const { t } = useI18n();
  const currentProvider = providers.find((entry) => entry.id === provider);
  const currentModel = currentProvider?.models.find((model) => model.id === modelId);
  const label = currentModel?.name ?? modelId;

  return (
    <Select.Root
      value={modelValue(provider, modelId)}
      disabled={disabled || providers.length === 0}
      onValueChange={(value) => {
        const [nextProvider, nextModelId] = JSON.parse(value) as [ProviderId, string];
        onChange(nextProvider, nextModelId);
      }}
    >
      <Select.Trigger className="composer-tool-button model-trigger" aria-label={t("选择对话模型")} title={disabled ? t("Agent 运行中不可切换模型") : label}>
        <Select.Value><span>{label}</span></Select.Value>
        <Select.Icon><ChevronDown size={12} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content chat-model-select" position="popper" sideOffset={6}>
          <Select.Viewport className="select-viewport">
            {providers.map((entry, index) => (
              <Select.Group key={entry.id}>
                {index > 0 && <Select.Separator className="select-separator" />}
                <Select.Label className="select-label">{entry.name}</Select.Label>
                {entry.models.map((model) => (
                  <Select.Item className="select-item model-select-item" value={modelValue(entry.id, model.id)} key={`${entry.id}:${model.id}`} title={`${model.name} · ${model.id}`}>
                    <Select.ItemText><span><strong>{model.name}</strong><small>{model.id}</small></span></Select.ItemText>
                    <Select.ItemIndicator><Check size={13} /></Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Group>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function DirectoryMenu({
  project,
  compact = false,
  onProjectChange,
  onChooseWorkspace,
}: Pick<NewChatViewProps, "project" | "onProjectChange" | "onChooseWorkspace"> & { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={compact ? "composer-tool-button compact-directory-trigger" : "directory-trigger"} type="button">
          <Folder size={15} />
          <span>{compact ? project?.name ?? t("普通对话") : t(project ? "更换目录" : "选择目录")}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content directory-menu" align="start" sideOffset={8}>
          <DropdownMenu.Item className="dropdown-item directory-item" onSelect={onChooseWorkspace}>
            <Folder size={15} />
            <span><strong>{t("打开工作目录…")}</strong><code>{t("由系统选择器授权目录")}</code></span>
          </DropdownMenu.Item>
          {project && (
            <DropdownMenu.Item className="dropdown-item directory-item" onSelect={() => onProjectChange(null)}>
              <span className="directory-empty">×</span>
              <span><strong>{t("移除工作目录")}</strong><code>{t("转为无本地文件访问的普通对话")}</code></span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SendControl({ isRunning, canSend, onStop }: { isRunning: boolean; canSend: boolean; onStop: () => void }) {
  const { t } = useI18n();
  if (isRunning) {
    return <button className="send-button stop-button" type="button" aria-label={t("停止 Agent")} onClick={onStop}><CircleStop size={16} /></button>;
  }
  return <button className="send-button" type="submit" aria-label={t("发送")} disabled={!canSend}><ArrowUp size={17} /></button>;
}

function InitialComposer(props: NewChatViewProps) {
  const { t } = useI18n();
  return (
    <section className="new-chat-view" aria-label={t("新建对话")}>
      <div className="composer-stage">
        <header className="composer-heading">
          <span className="orbit-mark"><BrandMark compact /><i /></span>
          <h1>{props.project ? t("在 {name} 中开始新对话", { name: props.project.name }) : t("今天想一起做什么？")}</h1>
          <p>
            {props.project
              ? t("Pi 将以该目录为边界读取文件、执行命令并追踪变更。")
              : t("直接提问，或选择工作目录开始一个真实的 Agent 会话。")}
          </p>
        </header>

        <form className="composer-card" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
          <textarea
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (!shouldSubmitOnEnter(event.nativeEvent)) return;
              event.preventDefault();
              if (props.prompt.trim() && !props.isRunning) props.onSubmit();
            }}
            placeholder={t("描述你想分析、构建或修改的内容…")}
            aria-label={t("对话内容")}
          />
          <div className="composer-toolbar">
            <button className="composer-tool-button" type="button" aria-label={t("添加附件")}><Paperclip size={15} /></button>
            <ModelSelector provider={props.modelProvider} modelId={props.modelId} providers={props.modelProviders} disabled={props.isRunning} onChange={props.onModelChange} />
            <SendControl isRunning={props.isRunning} canSend={Boolean(props.prompt.trim())} onStop={props.onStop} />
          </div>
        </form>

        <div className="conversation-context">
          <DirectoryMenu project={props.project} onProjectChange={props.onProjectChange} onChooseWorkspace={props.onChooseWorkspace} />
          <span className="context-copy">
            <strong>{props.project ? props.project.path : t("普通对话")}</strong>
            <small>{props.project ? t("Pi 工具将相对 {name} 运行", { name: props.project.name }) : t("未关联工作目录，Pi 使用隔离的空目录")}</small>
          </span>
        </div>
        <div className="context-hint-row">
          <p className="context-hint">{t("工作区内操作按权限模式执行；危险或越界行为仍会询问。")}</p>
          <ContextIndicator usage={props.contextUsage} />
        </div>
      </div>
    </section>
  );
}

function ThinkingActivity({ activity }: { activity: Extract<ChatActivity, { type: "thinking" }> }) {
  const { t } = useI18n();
  return (
    <Collapsible.Root className="agent-activity thinking-activity">
      <Collapsible.Trigger className="activity-trigger">
        <BrainCircuit size={14} />
        <span>{t("分析过程")}</span>
        <small>{t("按需查看")}</small>
        <ChevronDown size={13} className="activity-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Content className="thinking-content">{activity.text}</Collapsible.Content>
    </Collapsible.Root>
  );
}

function ToolActivity({ activity }: { activity: Extract<ChatActivity, { type: "tool" }> }) {
  const { t } = useI18n();
  const isSubagent = activity.name === "spawn_subagent" || activity.name === "pi_desktop_subagent";
  const Icon = isSubagent ? Users : TerminalSquare;
  const title = t(toolLabel(activity.name));
  return (
    <Collapsible.Root className={`agent-activity tool-activity tool-activity--${activity.status}`} defaultOpen={activity.status === "error"}>
      <Collapsible.Trigger className="activity-trigger">
        <Icon size={14} />
        <span>{title}</span>
        <small>{t(activity.status === "running" ? "运行中" : activity.status === "success" ? "完成" : "失败")}</small>
        {activity.status === "running" ? <i className="activity-spinner" /> : activity.status === "success" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        <ChevronDown size={13} className="activity-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Content className="tool-content">
        <div><span>{t("输入")}</span><pre>{formatData(activity.args)}</pre></div>
        {(activity.output || activity.status !== "running") && <div><span>{t("输出")}</span><pre>{activity.output || t("工具未返回文本")}</pre></div>}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

const toolLabels: Record<string, string> = {
  read: "读取文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "浏览目录",
  bash: "运行命令",
  edit: "编辑文件",
  write: "写入文件",
  spawn_subagent: "子 Agent",
  pi_desktop_subagent: "子 Agent",
};

function toolLabel(name: string) {
  return toolLabels[name] ?? name;
}

function ToolGroup({ tools }: { tools: Extract<ChatActivity, { type: "tool" }>[] }) {
  const { t } = useI18n();
  const allCommands = tools.length > 0 && tools.every((tool) => tool.name === "bash");
  const running = tools.some((tool) => tool.status === "running");
  const failed = tools.some((tool) => tool.status === "error");
  const title = tools.length === 0
    ? t("分析过程")
    : allCommands
      ? running
        ? t(tools.length > 1 ? "正在运行多个命令" : "正在运行命令")
        : t(tools.length > 1 ? "运行了多个命令" : "运行了 1 个命令")
      : running
        ? tools.length > 1 ? t("正在调用多个工具") : `${t("运行中")} · ${t(toolLabel(tools[0].name))}`
        : tools.length > 1 ? t("调用了多个工具") : `${t("完成")} · ${t(toolLabel(tools[0].name))}`;

  return (
    <Collapsible.Root className={`tool-group ${failed ? "has-error" : ""}`} defaultOpen={failed}>
      <Collapsible.Trigger className="tool-group-trigger">
        <TerminalSquare size={15} />
        <span>{title}</span>
        {running ? <i className="activity-spinner" /> : failed ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
        <ChevronDown size={14} className="activity-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Content className="tool-group-content">
        {tools.map((tool) => <ToolActivity key={tool.id} activity={tool} />)}
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
  const { t } = useI18n();
  const [customAnswer, setCustomAnswer] = useState("");
  return (
    <section className={`agent-activity question-activity ${activity.status === "answered" ? "is-answered" : ""}`}>
      <header><MessageCircleQuestion size={15} /><strong>{t("Pi 需要你的回答")}</strong></header>
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
            <input value={customAnswer} onChange={(event) => setCustomAnswer(event.target.value)} placeholder={t("输入其他回答…")} />
            <button type="submit" disabled={!customAnswer.trim()}>{t("提交")}</button>
          </form>
        </>
      )}
    </section>
  );
}

function MessageActivity({ text }: { text: string }) {
  if (!text) return null;
  return <div className="answer-content"><p>{text}</p></div>;
}

function ActivityTimeline({
  turn,
  onAnswerQuestion,
}: {
  turn: ChatTurn;
  onAnswerQuestion: NewChatViewProps["onAnswerQuestion"];
}) {
  const { t } = useI18n();
  const activities = Array.isArray(turn.activities) ? turn.activities : [];
  const visible = normalizeVisibleActivities(activities);
  const hasMessages = visible.some((activity) => activity.type === "message" && activity.text);
  const timeline: Array<
    | { type: "direct"; activity: Exclude<ChatActivity, { type: "tool" }> }
    | { type: "tools"; key: string; tools: Extract<ChatActivity, { type: "tool" }>[] }
  > = [];
  let tools: Extract<ChatActivity, { type: "tool" }>[] = [];

  function flushTools() {
    if (tools.length === 0) return;
    timeline.push({ type: "tools", key: `tools-${tools[0].id}`, tools });
    tools = [];
  }

  for (const activity of visible) {
    if (activity.type === "tool") {
      tools.push(activity);
      continue;
    }
    flushTools();
    timeline.push({ type: "direct", activity });
  }
  flushTools();

  if (visible.length === 0) {
    if (turn.answer) return <MessageActivity text={turn.answer} />;
    return turn.status === "running" ? <div className="agent-working"><i />{t("Pi 正在分析任务…")}</div> : null;
  }

  return (
    <>
      {timeline.map((item) => {
        if (item.type === "tools") return <ToolGroup key={item.key} tools={item.tools} />;
        if (item.activity.type === "message") return <MessageActivity key={item.activity.id} text={item.activity.text} />;
        if (item.activity.type === "thinking") return <ThinkingActivity key={item.activity.id} activity={item.activity} />;
        return <QuestionActivity key={item.activity.id} turnId={turn.id} activity={item.activity} onAnswer={onAnswerQuestion} />;
      })}
      {!hasMessages && turn.answer && <MessageActivity text={turn.answer} />}
    </>
  );
}

function ConversationTurn({ turn, onRetry, onAnswerQuestion }: {
  turn: ChatTurn;
  onRetry: (turnId: string) => void;
  onAnswerQuestion: NewChatViewProps["onAnswerQuestion"];
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copyQuestion() {
    await navigator.clipboard.writeText(turn.question);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <article className="qa-pair">
      <section className="qa-message qa-question" aria-label={t("用户消息")}>
        <div className="message-bubble-stack message-bubble-stack--user">
          <div className="question-content">{turn.question}</div>
          <div className="message-actions">
            <button type="button" onClick={() => void copyQuestion()} aria-label={t("复制用户输入")}>
              {copied ? <Check size={13} /> : <Copy size={13} />}<span>{t(copied ? "已复制" : "复制")}</span>
            </button>
            <button type="button" onClick={() => onRetry(turn.id)} disabled={turn.status === "running"}>
              <RotateCcw size={13} /><span>{t("重试")}</span>
            </button>
          </div>
        </div>
      </section>
      <section className="qa-message qa-answer" aria-label={t("Agent 回答")}>
        <div className="agent-response">
          <ActivityTimeline turn={turn} onAnswerQuestion={onAnswerQuestion} />
          {turn.usage && <ResponseUsageLine usage={turn.usage} />}
          {turn.status === "error" && <div className="agent-error"><XCircle size={14} />{turn.error}</div>}
          {turn.status === "stopped" && <div className="agent-stopped">{t("任务已停止")}</div>}
        </div>
      </section>
    </article>
  );
}

function ActiveConversation(props: NewChatViewProps) {
  const { t } = useI18n();
  return (
    <section className="active-conversation" aria-label={t("当前对话")}>
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
            onKeyDown={(event) => {
              if (!shouldSubmitOnEnter(event.nativeEvent)) return;
              event.preventDefault();
              if (props.prompt.trim() && !props.isRunning) props.onSubmit();
            }}
            placeholder={t(props.isRunning ? "Agent 执行中，可先停止当前任务…" : "继续给 Pi 指令…")}
            aria-label={t("继续对话")}
            disabled={props.isRunning}
          />
          <div className="compact-composer-toolbar">
            <button className="composer-tool-button" type="button" aria-label={t("添加附件")}><Paperclip size={15} /></button>
            <ModelSelector provider={props.modelProvider} modelId={props.modelId} providers={props.modelProviders} disabled={props.isRunning} onChange={props.onModelChange} />
            <DirectoryMenu compact project={props.project} onProjectChange={props.onProjectChange} onChooseWorkspace={props.onChooseWorkspace} />
            <SendControl isRunning={props.isRunning} canSend={Boolean(props.prompt.trim())} onStop={props.onStop} />
          </div>
        </form>
        <p className="dock-context">
          <span className="dock-scope">{props.project ? <><Folder size={12} /><code>{props.project.path}</code></> : <>{t("普通对话 · 隔离目录")}</>}</span>
          <ContextIndicator usage={props.contextUsage} />
        </p>
      </footer>
    </section>
  );
}

export function NewChatView(props: NewChatViewProps) {
  return props.turns.length ? <ActiveConversation {...props} /> : <InitialComposer {...props} />;
}
