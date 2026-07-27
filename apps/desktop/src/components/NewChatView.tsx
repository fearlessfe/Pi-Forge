import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
import {
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Copy,
  ExternalLink,
  FileBox,
  FileDiff,
  Folder,
  FolderOpen,
  GitFork,
  MessageCircleQuestion,
  RotateCcw,
  TerminalSquare,
  ShieldCheck,
  Undo2,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CommandInfo, ContextUsageInfo, ProviderCatalogEntry, ProviderId, QueuedMessages, ResponseUsage, TaskFileChange } from "../contracts";
import { normalizeVisibleActivities } from "../conversation-activity";
import { fileExtension, isArtifactChange } from "../file-changes";
import { shouldSubmitOnEnter } from "../keyboard";
import { inputTokensIncludingCache } from "../response-usage";
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
  queuedMessages: QueuedMessages;
  onPromptChange: (value: string) => void;
  onProjectChange: (project: Project | null) => void;
  onChooseWorkspace: () => void;
  onOpenTerminal: () => void;
  onModelChange: (provider: ProviderId, modelId: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onQueue: (mode: "steer" | "followUp") => void;
  onClearQueue: () => void;
  onAcceptChanges: (changeIds?: string[]) => void;
  onRevertChanges: (changeIds?: string[]) => void;
  onRetry: (turnId: string) => void;
  onForkTurn: (entryId: string) => void;
  onAnswerQuestion: (turnId: string, callId: string, answer: string) => void;
};

const desktopCommands: CommandInfo[] = [
  { name: "/new", description: "开始新对话", source: "desktop", sourceLabel: "Pi Desktop" },
  { name: "/settings", description: "打开设置", source: "desktop", sourceLabel: "Pi Desktop" },
  { name: "/plugins", description: "打开插件管理", source: "desktop", sourceLabel: "Pi Desktop" },
  { name: "/reload", description: "重新加载 Skills、Prompts 与 Extensions", source: "desktop", sourceLabel: "Pi Desktop" },
];

function useCommandPalette(props: NewChatViewProps) {
  const [commands, setCommands] = useState<CommandInfo[]>(desktopCommands);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let active = true;
    void window.piDesktop?.resources?.inventory(props.project?.path).then((inventory) => {
      if (active) setCommands([...desktopCommands, ...inventory.commands]);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [props.project?.path]);

  const matches = useMemo(() => {
    const value = props.prompt.trimStart();
    if (!value.startsWith("/") || value.includes("\n")) return [];
    const commandPrefix = value.split(/\s/, 1)[0].toLocaleLowerCase();
    return commands.filter((command) => command.name.toLocaleLowerCase().includes(commandPrefix)
      || command.description.toLocaleLowerCase().includes(commandPrefix.slice(1))).slice(0, 8);
  }, [commands, props.prompt]);

  useEffect(() => setSelected(0), [props.prompt]);

  function select(command: CommandInfo) {
    props.onPromptChange(`${command.name} `);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (matches.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && props.prompt.trim() !== matches[selected]?.name)) {
      event.preventDefault();
      select(matches[selected]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onPromptChange("");
      return true;
    }
    return false;
  }

  return { matches, selected, select, onKeyDown };
}

function CommandPalette({ matches, selected, onSelect }: { matches: CommandInfo[]; selected: number; onSelect: (command: CommandInfo) => void }) {
  const { t } = useI18n();
  if (matches.length === 0) return null;
  return <div className="command-palette" role="listbox" aria-label={t("可用命令")}>
    {matches.map((command, index) => <button className={index === selected ? "is-selected" : ""} type="button" role="option" aria-selected={index === selected} key={`${command.sourceLabel}:${command.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command)}>
      <code>{command.name}</code><span><strong>{t(command.description)}</strong><small>{command.source} · {command.sourceLabel}{command.argumentHint ? ` · ${command.argumentHint}` : ""}</small></span>
    </button>)}
  </div>;
}

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
  const input = inputTokensIncludingCache(usage);
  const requestSummary = usage.requestCount > 1
    ? t("本回答共 {count} 次模型请求；token 显示最终请求，费用为全部请求合计", { count: usage.requestCount })
    : t("本回答共 1 次模型请求");
  return (
    <footer className="response-usage" title={`${t("最终请求")}：${t("输入")} ${input.toLocaleString(locale)} · ${t("输出")} ${usage.outputTokens.toLocaleString(locale)} · ${t("缓存")} ${cache.toLocaleString(locale)} · ${t("总计")} ${usage.totalTokens.toLocaleString(locale)} tokens · ${requestSummary} · ${t("费用按模型目录单价估算")}`}>
      <span>{usage.provider}</span><strong>{model}</strong><i />
      <span>↑ {formatTokens(input)}</span><span>↓ {formatTokens(usage.outputTokens)}</span>
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
  const palette = useCommandPalette(props);
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
              if (palette.onKeyDown(event)) return;
              if (!shouldSubmitOnEnter(event.nativeEvent)) return;
              event.preventDefault();
              if (props.prompt.trim() && !props.isRunning) props.onSubmit();
            }}
            placeholder={t("描述你想分析、构建或修改的内容…")}
            aria-label={t("对话内容")}
          />
          <CommandPalette matches={palette.matches} selected={palette.selected} onSelect={palette.select} />
          <div className="composer-toolbar">
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
          <button className="terminal-launch-button" type="button" onClick={props.onOpenTerminal}><TerminalSquare size={14} />{t("终端")}</button>
        </div>
        <div className="context-hint-row">
          <p className="context-hint">{t("工作区内操作按权限模式执行；危险或越界行为仍会询问。")}</p>
          <ContextIndicator usage={props.contextUsage} />
        </div>
      </div>
    </section>
  );
}

function ToolActivity({ activity }: { activity: Extract<ChatActivity, { type: "tool" }> }) {
  const { t } = useI18n();
  const isSubagent = activity.name === "spawn_subagent" || activity.name === "pi_desktop_subagent";
  const subagent = activity.details?.subagent;
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
        {subagent && (
          <div className="subagent-run-details">
            <span>{t("运行记录")}</span>
            <section>
              <p><strong>{subagent.role}</strong><small>{t(subagent.status === "running" ? "运行中" : subagent.status === "completed" ? "完成" : subagent.status === "stopped" ? "已停止" : "失败")}</small></p>
              <code title={subagent.sessionId}>{t("会话")} {subagent.sessionId.slice(0, 8)}</code>
              {subagent.usage && <ResponseUsageLine usage={subagent.usage} />}
              {subagent.error && <em>{subagent.error}</em>}
            </section>
          </div>
        )}
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
  return <div className="answer-content markdown-content"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{text}</Markdown></div>;
}

function formatElapsedTime(seconds: number, t: ReturnType<typeof useI18n>["t"]): string {
  if (seconds < 60) return t("已运行 {seconds} 秒", { seconds });
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0
    ? t("已运行 {minutes} 分 {seconds} 秒", { minutes, seconds: remainder })
    : t("已运行 {minutes} 分", { minutes });
}

function RunningTaskStatus({ turn, onStop }: { turn: ChatTurn; onStop: () => void }) {
  const { t } = useI18n();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const visible = normalizeVisibleActivities(Array.isArray(turn.activities) ? turn.activities : []);
  const lastActivity = visible.at(-1);
  const waitingForAnswer = visible.some((activity) => activity.type === "question" && activity.status === "pending");

  useEffect(() => {
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => window.clearInterval(timer);
  }, [turn.id]);

  let phase = t("正在准备下一步");
  if (waitingForAnswer) phase = t("需要你的回答才能继续");
  else if (lastActivity?.type === "thinking") phase = t("正在分析与组织回复");
  else if (lastActivity?.type === "message") phase = t("正在生成回复");
  else if (lastActivity?.type === "tool") {
    phase = lastActivity.status === "running"
      ? t("正在使用工具：{tool}", { tool: t(toolLabel(lastActivity.name)) })
      : t("正在整理工具结果");
  } else if (lastActivity?.type === "question") phase = t("正在继续任务");

  return <div className={`task-status-bar ${waitingForAnswer ? "is-waiting" : ""}`}>
    <span className="task-status-signal" aria-hidden="true"><i /><i /><i /></span>
    <span className="task-status-copy" role="status" aria-live="polite">
      <small>{t(waitingForAnswer ? "等待你的输入" : "任务进行中")}</small>
      <strong>{phase}</strong>
    </span>
    <time title={t("任务运行时长")} aria-hidden="true">{formatElapsedTime(elapsedSeconds, t)}</time>
    <button type="button" onClick={onStop}><CircleStop size={14} />{t("停止任务")}</button>
  </div>;
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
        if (item.activity.type === "thinking") return <MessageActivity key={item.activity.id} text={item.activity.text} />;
        return <QuestionActivity key={item.activity.id} turnId={turn.id} activity={item.activity} onAnswer={onAnswerQuestion} />;
      })}
      {!hasMessages && turn.answer && <MessageActivity text={turn.answer} />}
    </>
  );
}

function ConversationTurn({ turn, running, onRetry, onForkTurn, onAnswerQuestion, onOpenChange, onAcceptChanges, onRevertChanges }: {
  turn: ChatTurn;
  running: boolean;
  onRetry: (turnId: string) => void;
  onForkTurn: NewChatViewProps["onForkTurn"];
  onAnswerQuestion: NewChatViewProps["onAnswerQuestion"];
  onOpenChange: (change: TaskFileChange) => void;
  onAcceptChanges: NewChatViewProps["onAcceptChanges"];
  onRevertChanges: NewChatViewProps["onRevertChanges"];
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
            {turn.sessionEntryId && <button type="button" onClick={() => onForkTurn(turn.sessionEntryId!)} disabled={turn.status === "running"}>
              <GitFork size={13} /><span>{t("从此处 Fork")}</span>
            </button>}
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
      <FileChangesPanel changes={turn.fileChanges ?? []} running={running} onOpen={onOpenChange} onAccept={onAcceptChanges} onRevert={onRevertChanges} />
    </article>
  );
}

function FileChangesPanel({ changes, running, onOpen, onAccept, onRevert }: {
  changes: TaskFileChange[];
  running: boolean;
  onOpen: (change: TaskFileChange) => void;
  onAccept: (changeIds?: string[]) => void;
  onRevert: (changeIds?: string[]) => void;
}) {
  const { t } = useI18n();
  const pending = changes.filter((change) => change.status === "pending");
  if (changes.length === 0) return null;
  return <Collapsible.Root className="file-changes-panel turn-file-changes" defaultOpen>
    <header>
      <Collapsible.Trigger className="file-changes-trigger"><FileDiff size={14} /><strong>{t("改动的文件")}</strong><span>{changes.length}</span><ChevronDown size={13} /></Collapsible.Trigger>
      {pending.length > 0 && <div><button type="button" onClick={() => onAccept(pending.map((change) => change.id))}><ShieldCheck size={12} />{t("全部接受")}</button><button type="button" disabled={running || pending.some((change) => !change.revertible)} onClick={() => onRevert(pending.map((change) => change.id))}><Undo2 size={12} />{t("全部回退")}</button></div>}
    </header>
    <Collapsible.Content className="file-changes-content">
      {changes.map((change) => <div key={change.id} className={`file-change-row is-${change.status}`}>
        <button className="file-change-open" type="button" onClick={() => onOpen(change)} title={t("在右侧查看 Diff")}>
          {isArtifactChange(change) ? <FileBox size={13} /> : <FileDiff size={13} />}
          <code>{change.relativePath}</code>
          {isArtifactChange(change) && <span className="file-change-type">{t("成果物")}</span>}
          <span>{t(change.kind === "created" ? "新建" : "修改")}</span><em>{t(change.status)}</em>
        </button>
        {change.status === "pending" && <div className="file-change-actions"><button type="button" onClick={() => onAccept([change.id])}>{t("接受")}</button><button type="button" disabled={running || !change.revertible} onClick={() => onRevert([change.id])}>{t(change.revertible ? "回退" : "无法自动回退")}</button></div>}
        {change.error && <p>{change.error}</p>}
      </div>)}
    </Collapsible.Content>
  </Collapsible.Root>;
}

function FileChangeInspector({ change, onClose }: { change: TaskFileChange; onClose: () => void }) {
  const { t } = useI18n();
  const isArtifact = isArtifactChange(change);
  const [action, setAction] = useState<"open" | "reveal" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setAction(null);
    setActionError(null);
  }, [change.id]);

  async function performAction(nextAction: "open" | "reveal") {
    setAction(nextAction);
    setActionError(null);
    try {
      const api = window.piDesktop?.agent;
      if (!api) throw new Error(t("桌面文件操作不可用。"));
      if (nextAction === "open") await api.openChange(change.id);
      else await api.revealChange(change.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error));
    } finally {
      setAction(null);
    }
  }

  return <aside className="chat-inspector" aria-label={t("文件变更详情")}>
    <header className="chat-inspector__header">
      <div>{isArtifact ? <FileBox size={16} /> : <FileDiff size={16} />}<span><strong>{isArtifact ? t("成果物") : "Diff"}</strong><code title={change.path}>{change.relativePath}</code></span></div>
      <div className="chat-inspector__actions">
        <button type="button" disabled={action !== null} onClick={() => void performAction("open")} title={t("使用系统默认应用打开")}><ExternalLink size={14} /><span>{t("打开")}</span></button>
        <button type="button" disabled={action !== null} onClick={() => void performAction("reveal")} title={t("在文件管理器中显示")}><FolderOpen size={14} /><span>{t("定位")}</span></button>
        <button type="button" onClick={onClose} aria-label={t("关闭文件变更详情")}><X size={16} /></button>
      </div>
    </header>
    <div className="chat-inspector__meta"><span>{t(change.kind === "created" ? "新建" : "修改")}</span><span className={`is-${change.status}`}>{t(change.status)}</span><code title={change.path}>{change.path}</code></div>
    {isArtifact ? <div className="chat-inspector__artifact">
      <div className="artifact-file-mark"><FileBox size={30} /><span>{fileExtension(change.relativePath)}</span></div>
      <strong>{t("成果物已生成")}</strong>
      <p>{t("该文件是二进制文件或体积较大，无法显示文本 Diff。你可以直接打开，或在文件管理器中定位。")}</p>
      <code>{change.path}</code>
      <div><button type="button" disabled={action !== null} onClick={() => void performAction("open")}><ExternalLink size={14} />{action === "open" ? t("正在打开…") : t("打开成果物")}</button><button type="button" disabled={action !== null} onClick={() => void performAction("reveal")}><FolderOpen size={14} />{action === "reveal" ? t("正在定位…") : t("在文件管理器中显示")}</button></div>
    </div> : <pre className="chat-inspector__diff" aria-label={t("文件 Diff")}>{change.patch.split("\n").map((line, index) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "is-added" : line.startsWith("-") && !line.startsWith("---") ? "is-removed" : line.startsWith("@@") ? "is-hunk" : line.startsWith("---") || line.startsWith("+++") ? "is-file" : ""} key={`${index}:${line}`}><i>{index + 1}</i><code>{line || " "}</code></span>)}</pre>}
    {(change.error || actionError) && <p className="chat-inspector__error"><XCircle size={13} />{actionError || change.error}</p>}
  </aside>;
}

function ActiveConversation(props: NewChatViewProps & { onOpenChange: (change: TaskFileChange) => void }) {
  const { t } = useI18n();
  const palette = useCommandPalette(props);
  const runningTurn = [...props.turns].reverse().find((turn) => turn.status === "running");
  return (
    <section className="active-conversation" aria-label={t("当前对话")}>
      <div className="conversation-scroll" aria-live="polite">
        <div className="conversation-turns">
          {props.turns.map((turn) => <ConversationTurn key={turn.id} turn={turn} running={props.isRunning} onRetry={props.onRetry} onForkTurn={props.onForkTurn} onAnswerQuestion={props.onAnswerQuestion} onOpenChange={props.onOpenChange} onAcceptChanges={props.onAcceptChanges} onRevertChanges={props.onRevertChanges} />)}
        </div>
      </div>
      <footer className="conversation-dock">
        {props.isRunning && runningTurn && <RunningTaskStatus turn={runningTurn} onStop={props.onStop} />}
        {(props.queuedMessages.steering.length > 0 || props.queuedMessages.followUp.length > 0) && <div className="queued-messages"><span>{t("已排队 {count} 条消息", { count: props.queuedMessages.steering.length + props.queuedMessages.followUp.length })}</span>{props.queuedMessages.steering.map((message) => <em key={`steer:${message}`}>{t("立即调整")} · {message}</em>)}{props.queuedMessages.followUp.map((message) => <em key={`follow:${message}`}>{t("稍后继续")} · {message}</em>)}<button type="button" onClick={props.onClearQueue}>{t("清空队列")}</button></div>}
        <form className="compact-composer" onSubmit={(event) => {
          event.preventDefault();
          if (props.isRunning) props.onQueue("followUp");
          else props.onSubmit();
        }}>
          <textarea
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (palette.onKeyDown(event)) return;
              if (!shouldSubmitOnEnter(event.nativeEvent)) return;
              event.preventDefault();
              if (!props.prompt.trim()) return;
              if (props.isRunning) props.onQueue("followUp");
              else props.onSubmit();
            }}
            placeholder={t(props.isRunning ? "输入调整指令，选择立即介入或稍后继续…" : "继续给 Pi 指令…")}
            aria-label={t("继续对话")}
          />
          <CommandPalette matches={palette.matches} selected={palette.selected} onSelect={palette.select} />
          <div className="compact-composer-toolbar">
            <ModelSelector provider={props.modelProvider} modelId={props.modelId} providers={props.modelProviders} disabled={props.isRunning} onChange={props.onModelChange} />
            <DirectoryMenu compact project={props.project} onProjectChange={props.onProjectChange} onChooseWorkspace={props.onChooseWorkspace} />
            <button className="composer-tool-button terminal-tool-button" type="button" onClick={props.onOpenTerminal} aria-label={t("打开终端")} title={t("打开终端")}><TerminalSquare size={14} /></button>
            {props.isRunning && <><button className="queue-button" type="button" disabled={!props.prompt.trim()} onClick={() => props.onQueue("steer")}>{t("立即调整")}</button><button className="queue-button" type="submit" disabled={!props.prompt.trim()}>{t("稍后继续")}</button></>}
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
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const selectedChange = props.turns.flatMap((turn) => turn.fileChanges ?? []).find((change) => change.id === selectedChangeId);

  useEffect(() => {
    if (selectedChangeId && !selectedChange) setSelectedChangeId(null);
  }, [selectedChange, selectedChangeId]);

  if (!props.turns.length) return <InitialComposer {...props} />;
  return <div className={`chat-workspace ${selectedChange ? "has-inspector" : ""}`}>
    <ActiveConversation {...props} onOpenChange={(change) => setSelectedChangeId(change.id)} />
    {selectedChange && <FileChangeInspector change={selectedChange} onClose={() => setSelectedChangeId(null)} />}
  </div>;
}
