import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
import {
  ArrowUp,
  BookOpen,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CircleStop,
  Copy,
  ExternalLink,
  FileBox,
  FileDiff,
  Folder,
  FolderOpen,
  GitFork,
  Gauge,
  MessageCircleQuestion,
  Paperclip,
  RotateCcw,
  SlidersHorizontal,
  TerminalSquare,
  ShieldCheck,
  Undo2,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type ComponentPropsWithoutRef, type DragEvent, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CommandInfo, ContextBudgetReport, ContextUsageInfo, McpOverview, PlanReviewArtifact, ProjectResourceSelection, ProviderCatalogEntry, ProviderId, QueuedMessages, ResolvePlanReviewInput, ResourceInventory, ResponseUsage, TaskFileChange } from "../contracts";
import { classifyAttachmentFile, hasComposerAttachments, inlineTextFileBytes, maxImageBytes, maxTextFileBytes, type ComposerAttachments, type ComposerFile, type ComposerImage } from "../composer-attachments";
import { normalizeVisibleActivities } from "../conversation-activity";
import { conversationAnnouncementSnapshot, isNearConversationBottom, nextConversationAnnouncement, safeMarkdownHref } from "../conversation-presentation";
import { fileExtension, isArtifactChange } from "../file-changes";
import { shouldSubmitOnEnter } from "../keyboard";
import { inputTokensIncludingCache } from "../response-usage";
import { useI18n } from "../i18n";
import type { ChatActivity, ChatTurn, Project } from "../types";
import { parseModelValue } from "./model-selector-value";
import { BrandMark } from "./BrandMark";
import { PlanReviewPanel } from "./PlanReviewPanel";

type NewChatViewProps = {
  project: Project | null;
  turns: ChatTurn[];
  modelId: string;
  modelProvider: ProviderId;
  modelProviders: ProviderCatalogEntry[];
  modelSupportsImages: boolean;
  contextUsage?: ContextUsageInfo;
  contextBudget?: ContextBudgetReport;
  resourceRevision: number;
  planReviews: PlanReviewArtifact[];
  prompt: string;
  attachments: ComposerAttachments;
  isRunning: boolean;
  queuedMessages: QueuedMessages;
  onPromptChange: (value: string) => void;
  onAttachmentsChange: (update: (current: ComposerAttachments) => ComposerAttachments) => void;
  onAttachmentError: (message: string) => void;
  onProjectChange: (project: Project | null) => void;
  onChooseWorkspace: () => void;
  onOpenTerminal: () => void;
  onOpenContextBudget: () => void;
  onOpenLink: (url: string) => void;
  onOpenExternalLink: (url: string) => void;
  onResourcesChanged: () => void;
  onResolvePlanReview: (input: ResolvePlanReviewInput) => Promise<void>;
  onModelChange: (provider: ProviderId, modelId: string) => void;
  onSubmit: (promptOverride?: string) => void;
  onStop: () => void;
  onQueue: (mode: "steer" | "followUp", promptOverride?: string) => void;
  onClearQueue: () => void;
  onAcceptChanges: (changeIds?: string[]) => void;
  onRevertChanges: (changeIds?: string[]) => void;
  onRetry: (turnId: string) => void;
  onForkTurn: (entryId: string) => void;
  onAnswerQuestion: (turnId: string, callId: string, answer: string) => void;
};

const desktopCommands: CommandInfo[] = [
  { name: "/init", description: "生成或更新项目 AGENTS.md", source: "desktop", sourceLabel: "Pi Desktop" },
  { name: "/new", description: "开始新对话", source: "desktop", sourceLabel: "Pi Desktop" },
  { name: "/settings", description: "打开设置", source: "desktop", sourceLabel: "Pi Desktop" },
  { name: "/plugins", description: "打开插件管理", source: "desktop", sourceLabel: "Pi Desktop" },
  { name: "/reload", description: "重新加载 Skills、Prompts 与 Extensions", source: "desktop", sourceLabel: "Pi Desktop" },
];

const composerToolButtonClass = "inline-flex h-control-md min-w-control-md cursor-pointer items-center justify-center gap-base rounded-sm px-base text-caption text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label-2 active:bg-fill-2 active:scale-[0.98] data-[state=open]:bg-fill data-[state=open]:text-label-2 disabled:pointer-events-none disabled:opacity-40";
const secondaryButtonClass = "inline-flex h-control-md cursor-pointer items-center gap-base rounded-sm border border-separator px-loose text-caption text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98]";
const queueButtonClass = "h-control-sm cursor-pointer rounded-sm border border-separator bg-fill px-base text-caption text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const sendButtonBaseClass = "ml-auto grid size-control-md cursor-pointer place-items-center rounded-md transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const toolSectionLabelClass = "mb-[5px] block text-caption font-bold uppercase tracking-[0.08em] text-label-3";
const toolPreClass = "m-0 max-h-[230px] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-bg p-[9px] font-mono text-caption leading-[1.55] text-label-2";
const messageActionButtonClass = "inline-flex h-control-sm cursor-pointer items-center gap-[5px] rounded-sm border-0 bg-transparent px-base text-caption text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label-2 active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const panelHeaderButtonClass = "inline-flex cursor-pointer items-center gap-tight rounded-sm border border-separator bg-transparent px-[7px] py-tight text-caption text-label-2 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const changeStatusClass: Record<TaskFileChange["status"], string> = { pending: "text-label-3", accepted: "text-green", reverted: "text-orange", conflict: "text-red" };
const toolStatusClass: Record<Extract<ChatActivity, { type: "tool" }>["status"], { root: string; icon: string; label: string }> = {
  running: { root: "hover:border-accent/32 data-[state=open]:border-accent/32 data-[state=open]:bg-accent/8", icon: "text-accent", label: "text-accent" },
  success: { root: "border-green/16 bg-green/8 hover:border-green/32 data-[state=open]:border-green/32", icon: "text-green", label: "text-green" },
  error: { root: "border-red/24 bg-red/8 hover:border-red/40 data-[state=open]:border-red/40", icon: "text-red", label: "text-red" },
};
const MarkdownNavigationContext = createContext<Pick<NewChatViewProps, "onOpenLink" | "onOpenExternalLink">>({
  onOpenLink: () => undefined,
  onOpenExternalLink: () => undefined,
});

function SafeMarkdownLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const { onOpenLink, onOpenExternalLink } = useContext(MarkdownNavigationContext);
  const safeHref = safeMarkdownHref(href);
  if (!safeHref) return <span>{children}</span>;
  return <a href={safeHref} onClick={(event) => {
    event.preventDefault();
    if (event.metaKey || event.ctrlKey || event.shiftKey) onOpenExternalLink(safeHref);
    else onOpenLink(safeHref);
  }}>{children}</a>;
}

const markdownComponents = { a: SafeMarkdownLink };
const initialVisibleTurnCount = 80;
const earlierTurnBatchSize = 50;

function useCommandPalette(props: NewChatViewProps) {
  const [commands, setCommands] = useState<CommandInfo[]>(desktopCommands);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let active = true;
    void window.piDesktop?.resources?.inventory(props.project?.path).then((inventory) => {
      if (active) setCommands([...desktopCommands, ...inventory.commands]);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [props.project?.path, props.resourceRevision]);

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

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): CommandInfo | null | undefined {
    if (matches.length === 0) return undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return null;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      select(matches[selected]);
      return null;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = matches[selected];
      select(command);
      return command;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onPromptChange("");
      return null;
    }
    return undefined;
  }

  return { matches, selected, select, onKeyDown };
}

function CommandPalette({ matches, selected, placement, onSelect }: { matches: CommandInfo[]; selected: number; placement: "inside" | "above"; onSelect: (command: CommandInfo) => void }) {
  const { t } = useI18n();
  if (matches.length === 0) return null;
  return <div className={`absolute z-20 grid max-h-[290px] overflow-auto rounded-md border border-separator bg-bg-grouped p-tight shadow-2 ${placement === "inside" ? "inset-x-base bottom-12" : "inset-x-0 bottom-[calc(100%+8px)]"}`} role="listbox" aria-label={t("可用命令")}>
    {matches.map((command, index) => <button className={`grid cursor-pointer grid-cols-[minmax(120px,auto)_minmax(0,1fr)] items-center gap-loose rounded-sm px-base py-base text-left text-label ${index === selected ? "bg-fill-3" : "hover:bg-fill"}`} type="button" role="option" aria-selected={index === selected} key={`${command.sourceLabel}:${command.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command)}>
      <code className="font-mono text-caption leading-[1.3] text-accent">{command.name}</code><span className="block min-w-0"><strong className="block truncate text-caption font-semibold">{t(command.description)}</strong><small className="mt-[3px] block text-caption text-label-3">{command.source} · {command.sourceLabel}{command.argumentHint ? ` · ${command.argumentHint}` : ""}</small></span>
    </button>)}
  </div>;
}

const attachmentAcceptTypes = "image/*,text/*,.json,.md,.markdown,.yaml,.yml,.toml,.csv,.ts,.tsx,.js,.jsx,.py,.sh,.xml,.html,.css,.sql,.log,.ini,.cfg,.conf,.env";

function attachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function useComposerAttachments(props: NewChatViewProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function addFiles(fileList: File[]) {
    for (const file of fileList) {
      const kind = classifyAttachmentFile(file.name, file.type);
      if (kind === "unsupported") {
        props.onAttachmentError(t("暂不支持该文件类型"));
        continue;
      }
      if (kind === "image") {
        if (!props.modelSupportsImages) {
          props.onAttachmentError(t("当前模型不支持图片输入"));
          continue;
        }
        if (file.size > maxImageBytes) {
          props.onAttachmentError(t("图片大小不能超过 10 MB"));
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          const data = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
          if (!data) return;
          const image: ComposerImage = {
            id: attachmentId(),
            name: file.name || t("粘贴的图片"),
            mimeType: file.type || "image/png",
            data,
            dataUrl,
          };
          props.onAttachmentsChange((current) => ({ ...current, images: [...current.images, image] }));
        };
        reader.onerror = () => props.onAttachmentError(t("无法读取文件"));
        reader.readAsDataURL(file);
        continue;
      }
      if (file.size > maxTextFileBytes) {
        props.onAttachmentError(t("文件大小不能超过 1 MB"));
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") return;
        const attachment: ComposerFile = {
          id: attachmentId(),
          name: file.name || t("未命名文件"),
          mimeType: file.type || "text/plain",
          size: file.size,
          content: reader.result,
        };
        props.onAttachmentsChange((current) => ({ ...current, files: [...current.files, attachment] }));
      };
      reader.onerror = () => props.onAttachmentError(t("无法读取文件"));
      reader.readAsText(file);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  function onDragOver(event: DragEvent<HTMLFormElement>) {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  }

  function onFilePicked(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function removeImage(id: string) {
    props.onAttachmentsChange((current) => ({ ...current, images: current.images.filter((image) => image.id !== id) }));
  }

  function removeFile(id: string) {
    props.onAttachmentsChange((current) => ({ ...current, files: current.files.filter((file) => file.id !== id) }));
  }

  return { fileInputRef, onPaste, onDrop, onDragOver, onFilePicked, removeImage, removeFile, openPicker: () => fileInputRef.current?.click() };
}

function AttachmentStrip({ attachments, onRemoveImage, onRemoveFile }: {
  attachments: ComposerAttachments;
  onRemoveImage: (id: string) => void;
  onRemoveFile: (id: string) => void;
}) {
  const { t } = useI18n();
  if (!hasComposerAttachments(attachments)) return null;
  return (
    <div className="flex flex-none flex-wrap items-center gap-[6px] overflow-auto pb-base" aria-label={t("附件列表")}>
      {attachments.images.map((image) => (
        <span className="relative inline-flex flex-none" key={image.id}>
          <img className="size-[44px] rounded-sm border border-separator object-cover" src={image.dataUrl} alt={image.name} title={image.name} />
          <button className="absolute -top-[5px] -right-[5px] grid size-[16px] cursor-pointer place-items-center rounded-full border border-separator bg-bg-grouped text-label-3 transition-colors duration-150 ease-apple hover:text-label" type="button" aria-label={t("移除附件")} title={t("移除附件")} onClick={() => onRemoveImage(image.id)}><X size={10} /></button>
        </span>
      ))}
      {attachments.files.map((file) => (
        <span className="inline-flex h-[28px] flex-none items-center gap-tight rounded-full border border-separator bg-bg px-base text-caption text-label-2" key={file.id} title={`${file.name} · ${t(file.size <= inlineTextFileBytes ? "直接附加" : "按需读取")}`}>
          <FileBox size={12} className="text-accent" />
          <span className="max-w-[160px] truncate">{file.name}</span>
          <span className="text-label-3">{t(file.size <= inlineTextFileBytes ? "直接附加" : "按需读取")}</span>
          <button className="inline-flex cursor-pointer border-0 bg-transparent p-0 text-label-3 transition-colors duration-150 ease-apple hover:text-label" type="button" aria-label={t("移除附件")} title={t("移除附件")} onClick={() => onRemoveFile(file.id)}><X size={12} /></button>
        </span>
      ))}
    </div>
  );
}

function AttachButton({ supportsImages, onClick }: { supportsImages: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return <button className={composerToolButtonClass} type="button" aria-label={t("添加附件")} title={supportsImages ? t("添加附件") : t("当前模型不支持图片输入")} onClick={onClick}><Paperclip size={14} /></button>;
}

function formatData(value: unknown): string {  if (typeof value === "string") return value;
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

export function ContextIndicator({
  usage,
  budget,
  className = "",
  onOpenBudget,
}: {
  usage?: ContextUsageInfo;
  budget?: ContextBudgetReport;
  className?: string;
  onOpenBudget: () => void;
}) {
  const { t, locale } = useI18n();
  const hasUsage = Boolean(usage && usage.contextWindow > 0);
  if (!hasUsage && !budget) return null;
  const percent = usage?.percent === null || usage?.percent === undefined ? null : Math.min(100, Math.max(0, usage.percent));
  const tone = percent !== null && percent >= 90 ? "is-critical" : percent !== null && percent >= 70 ? "is-warning" : "";
  const title = usage?.tokens === null
    ? t("上下文刚完成压缩，将在模型下次响应后更新；上限 {limit} tokens", { limit: usage.contextWindow.toLocaleString(locale) })
    : usage ? t("当前上下文 {used} / {limit} tokens", { used: usage.tokens.toLocaleString(locale), limit: usage.contextWindow.toLocaleString(locale) }) : "";
  const usageIndicator = hasUsage && usage ? <span className={`context-indicator ${tone}`} title={title}>
      <span>{t("上下文")}</span>
      <strong>{usage.tokens === null ? "?" : formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}</strong>
      <progress max={100} value={percent ?? 0} aria-label={t("上下文使用比例")} />
      <em>{percent === null ? t("待更新") : `${percent.toFixed(0)}%`}</em>
    </span> : null;
  if (!budget) return <span className={className}>{usageIndicator}</span>;

  const heaviest = budget.groups.flatMap((group) => group.items)
    .filter((item) => item.estimateStatus === "estimated" && item.baselineEstimatedTokens > 0)
    .sort((left, right) => right.baselineEstimatedTokens - left.baselineEstimatedTokens || left.name.localeCompare(right.name))
    .slice(0, 3);
  return (
    <details className={`group relative ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-base rounded-sm px-tight py-tight text-caption text-label-3 transition-colors duration-150 ease-apple hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/32 [&::-webkit-details-marker]:hidden" aria-label={t("查看上下文与资源预算")}>
        {usageIndicator}
        <span className="inline-flex items-center gap-tight rounded-full bg-accent/8 px-base py-tight text-accent"><Gauge size={12} /><span>{t("默认")}</span><strong className="font-mono font-semibold">~{formatTokens(budget.baselineEstimatedTokens)}</strong></span>
        <ChevronDown className="transition-transform duration-150 ease-apple group-open:rotate-180" size={12} aria-hidden="true" />
      </summary>
      <section className="absolute right-0 bottom-[calc(100%+8px)] z-30 w-[340px] max-w-[calc(100vw-32px)] rounded-md border border-separator bg-bg p-card text-left shadow-3" aria-label={t("资源预算明细")}>
        <header><strong className="text-callout font-semibold text-label">{t("默认上下文预算")}</strong><p className="mt-tight text-caption leading-normal text-label-3">{t("默认值来自真实会话组装后的系统提示词和启用工具 schemas；Skill 与 Prompt 正文按需加载。")}</p></header>
        <dl className="mt-loose grid grid-cols-2 gap-base">
          {[{ label: "完整默认", value: budget.baselineEstimatedTokens }, { label: "系统提示词", value: budget.systemPromptEstimatedTokens }, { label: "工具 schemas", value: budget.toolSchemaEstimatedTokens }, { label: "按需资源", value: budget.onDemandEstimatedTokens }].map((entry) => <div className="rounded-sm bg-bg-grouped px-base py-base" key={entry.label}><dt className="text-mini text-label-3">{t(entry.label)}</dt><dd className="mt-tight font-mono text-caption font-semibold text-label">~{formatTokens(entry.value)}</dd></div>)}
        </dl>
        <div className="mt-loose border-t border-separator pt-loose"><strong className="text-caption font-semibold text-label-2">{t("最重默认资源")}</strong><ol className="mt-base grid list-none gap-base p-0">{heaviest.map((item) => <li className="flex items-center justify-between gap-base text-caption" key={item.id}><span className="min-w-0 truncate text-label-2">{item.name}</span><span className="flex-none font-mono text-label-3">~{formatTokens(item.baselineEstimatedTokens)}</span></li>)}</ol>{heaviest.length === 0 && <p className="mt-base text-caption text-label-3">{t("当前没有可估算的默认上下文资源。")}</p>}</div>
        <button className="mt-loose inline-flex h-control-md w-full cursor-pointer items-center justify-center gap-base rounded-sm border border-separator bg-bg-grouped-2 px-loose text-caption font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/32" type="button" onClick={onOpenBudget}>{t("查看完整 Context Budget")}<ExternalLink size={13} /></button>
      </section>
    </details>
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
    <footer className="flex flex-wrap items-center gap-[6px] px-[3px] font-mono text-caption text-label-3 tabular-nums" title={`${t("最终请求")}：${t("输入")} ${input.toLocaleString(locale)} · ${t("输出")} ${usage.outputTokens.toLocaleString(locale)} · ${t("缓存")} ${cache.toLocaleString(locale)} · ${t("总计")} ${usage.totalTokens.toLocaleString(locale)} tokens · ${requestSummary} · ${t("费用按模型目录单价估算")}`}>
      <span>{usage.provider}</span><strong className="max-w-[250px] truncate font-medium text-label-2">{model}</strong><i className="size-[2px] rounded-full bg-fill-3" />
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
  const selectedValue = currentModel ? modelValue(provider, modelId) : "";

  return (
    <Select.Root
      value={selectedValue}
      disabled={disabled || providers.length === 0}
      onValueChange={(value) => {
        const next = parseModelValue(value);
        if (!next) return;
        const [nextProvider, nextModelId] = next;
        onChange(nextProvider, nextModelId);
      }}
    >
      <Select.Trigger className="grid h-control-md max-w-[230px] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-base rounded-sm px-base font-mono text-caption text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label-2 active:bg-fill-2 active:scale-[0.98] data-[state=open]:bg-fill data-[state=open]:text-label-2 disabled:pointer-events-none disabled:opacity-40" aria-label={t("选择对话模型")} title={disabled ? t("Agent 运行中不可切换模型") : label}>
        <Select.Value><span className="block truncate">{label}</span></Select.Value>
        <Select.Icon><ChevronDown size={14} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content w-[min(640px,calc(100vw-32px),var(--radix-select-content-available-width))] min-w-[min(520px,calc(100vw-32px),var(--radix-select-content-available-width))] max-h-[min(520px,var(--radix-select-content-available-height))]" position="popper" sideOffset={6}>
          <Select.Viewport className="max-h-[min(500px,var(--radix-select-content-available-height))] w-full">
            {providers.map((entry, index) => (
              <Select.Group key={entry.id}>
                {index > 0 && <Select.Separator className="mx-1 my-[6px] h-px bg-separator" />}
                <Select.Label className="px-[9px] pt-base pb-[5px] text-caption font-semibold uppercase tracking-[0.04em] text-label-3">{entry.name}</Select.Label>
                {entry.models.map((model) => (
                  <Select.Item className="select-item model-select-item flex min-h-[52px] items-center justify-between rounded-sm px-[11px] py-base" value={modelValue(entry.id, model.id)} key={`${entry.id}:${model.id}`} title={`${model.name} · ${model.id}`}>
                    <Select.ItemText><span><strong>{model.name}</strong><small className="whitespace-normal leading-[1.35] wrap-anywhere">{model.id}</small></span></Select.ItemText>
                    <Select.ItemIndicator><Check size={14} /></Select.ItemIndicator>
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
        <button className={compact ? `${composerToolButtonClass} max-w-[155px]` : `${secondaryButtonClass} font-semibold`} type="button">
          <Folder size={16} />
          <span className="truncate">{compact ? project?.name ?? t("普通对话") : t(project ? "更换目录" : "选择目录")}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content w-[420px]" align="start" sideOffset={8}>
          <DropdownMenu.Item className="dropdown-item grid min-h-[49px] grid-cols-[28px_minmax(0,1fr)] items-center gap-base rounded-sm px-base py-[6px]" onSelect={onChooseWorkspace}>
            <Folder size={16} className="text-accent" />
            <span><strong className="block text-caption font-semibold">{t("打开工作目录…")}</strong><code className="mt-[3px] block font-mono text-caption text-label-3">{t("由系统选择器授权目录")}</code></span>
          </DropdownMenu.Item>
          {project && (
            <DropdownMenu.Item className="dropdown-item grid min-h-[49px] grid-cols-[28px_minmax(0,1fr)] items-center gap-base rounded-sm px-base py-[6px]" onSelect={() => onProjectChange(null)}>
              <span className="grid size-control-sm place-items-center rounded-sm bg-red/8 text-red">×</span>
              <span><strong className="block text-caption font-semibold">{t("移除工作目录")}</strong><code className="mt-[3px] block font-mono text-caption text-label-3">{t("转为无本地文件访问的普通对话")}</code></span>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function nextProjectResourceSelection(
  mode: "inherit" | "custom",
  kind: "skill" | "mcp",
  key: string,
  current: ProjectResourceSelection,
): ProjectResourceSelection {
  if (mode === "inherit") {
    return kind === "skill" ? { skills: [key], mcpServers: [] } : { skills: [], mcpServers: [key] };
  }
  const entries = kind === "skill" ? current.skills : current.mcpServers;
  const selected = entries.includes(key) ? entries.filter((entry) => entry !== key) : [...entries, key];
  return kind === "skill" ? { ...current, skills: selected } : { ...current, mcpServers: selected };
}

function ProjectResourceMenu({
  project,
  isRunning,
  compact = false,
  onResourcesChanged,
}: Pick<NewChatViewProps, "project" | "isRunning" | "onResourcesChanged"> & { compact?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<ResourceInventory>();
  const [overview, setOverview] = useState<McpOverview>();
  const [draftSkills, setDraftSkills] = useState<string[]>([]);
  const [draftServers, setDraftServers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    if (!project || !window.piDesktop?.resources || !window.piDesktop?.mcp) return;
    setLoading(true);
    setError("");
    try {
      const [nextInventory, nextOverview] = await Promise.all([
        window.piDesktop.resources.inventory(project.path),
        window.piDesktop.mcp.overview(project.path),
      ]);
      setInventory(nextInventory);
      setOverview(nextOverview);
      setDraftSkills(nextInventory.skills.filter((skill) => skill.enabled).map((skill) => skill.name));
      setDraftServers(nextOverview.servers.filter((server) => server.enabled && server.projectEnabled !== false).map((server) => server.key));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setInventory(undefined);
    setOverview(undefined);
    setDraftSkills([]);
    setDraftServers([]);
    if (project) void load();
  }, [project?.path]);

  async function saveSelection(selection?: { skills: string[]; mcpServers: string[] }) {
    if (!project || !window.piDesktop?.resources) return;
    setSaving(true);
    setError("");
    try {
      const settings = await window.piDesktop.resources.setProjectSelection(project.path, selection);
      setInventory((current) => current ? {
        ...current,
        projectSettings: settings,
        skills: current.skills.map((skill) => {
          const projectEnabled = settings.selectionMode === "custom" ? settings.selectedSkills.includes(skill.name) : true;
          return { ...skill, projectEnabled, enabled: skill.globalEnabled && projectEnabled };
        }),
      } : current);
      setOverview((current) => current ? {
        ...current,
        servers: current.servers.map((server) => ({
          ...server,
          projectEnabled: settings.selectionMode === "custom" ? settings.selectedMcpServers.includes(server.key) : true,
        })),
      } : current);
      setDraftSkills(settings.selectionMode === "custom"
        ? settings.selectedSkills
        : inventory?.skills.filter((skill) => skill.globalEnabled).map((skill) => skill.name) ?? []);
      setDraftServers(settings.selectionMode === "custom"
        ? settings.selectedMcpServers
        : overview?.servers.filter((server) => server.enabled).map((server) => server.key) ?? []);
      onResourcesChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function toggleSkill(name: string) {
    void saveSelection(nextProjectResourceSelection(custom ? "custom" : "inherit", "skill", name, {
      skills: draftSkills,
      mcpServers: draftServers,
    }));
  }

  function toggleServer(key: string) {
    void saveSelection(nextProjectResourceSelection(custom ? "custom" : "inherit", "mcp", key, {
      skills: draftSkills,
      mcpServers: draftServers,
    }));
  }

  if (!project) return null;
  const custom = inventory?.projectSettings.selectionMode === "custom";
  const selectedCount = (inventory?.skills.filter((skill) => skill.enabled).length ?? 0)
    + (overview?.servers.filter((server) => server.enabled && server.projectEnabled !== false).length ?? 0);
  const disabled = isRunning || saving;

  return (
    <DropdownMenu.Root open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) void load(); }}>
      <DropdownMenu.Trigger asChild>
        <button className={compact ? composerToolButtonClass : secondaryButtonClass} type="button" disabled={isRunning} aria-label={t("配置项目资源")} title={t("配置项目资源")}>
          <SlidersHorizontal size={14} />
          {!compact && <span>{t(custom ? "已选 {count} 项资源" : "资源 · 继承全局", { count: selectedCount })}</span>}
          {compact && custom && <span>{selectedCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dropdown-content grid max-h-[min(620px,calc(100vh-48px))] w-[min(480px,calc(100vw-32px))] gap-loose overflow-hidden p-card" align="start" sideOffset={8}>
          <header className="flex items-start justify-between gap-card">
            <span><strong className="block text-body font-semibold text-label">{t("项目资源")}</strong><small className="mt-tight block text-caption leading-[1.45] text-label-3">{t("自定义后，当前项目只加载选中的 Skills 和 MCP。")}</small></span>
            <span className={`rounded-full px-base py-tight text-mini font-semibold ${custom ? "bg-accent/12 text-accent" : "bg-fill text-label-3"}`}>{t(custom ? "自定义" : "继承全局")}</span>
          </header>

          {error && <p className="m-0 rounded-sm border border-red/32 bg-red/8 px-base py-base text-caption text-red" role="alert">{error}</p>}
          {loading && !inventory && <div className="grid min-h-[140px] place-items-center text-caption text-label-3">{t("正在加载项目资源…")}</div>}

          {inventory && overview && <div className="grid min-h-0 gap-card overflow-auto pr-tight">
            <section>
              <span className="mb-base flex items-center gap-base text-caption font-semibold text-label-2"><BookOpen size={14} />{t("Skills")}<small className="ml-auto font-normal text-label-3">{draftSkills.length} / {inventory.skills.filter((skill) => skill.globalEnabled).length}</small></span>
              <div className="grid gap-tight">
                {inventory.skills.map((skill) => {
                  const checked = draftSkills.includes(skill.name);
                  return <button className="flex min-h-[38px] items-center gap-base rounded-sm border-0 bg-transparent px-base text-left text-caption text-label-2 hover:bg-fill disabled:opacity-45" type="button" aria-pressed={checked} disabled={disabled || !skill.globalEnabled} onClick={() => toggleSkill(skill.name)} key={`${skill.source}:${skill.filePath}`}>
                    <span className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] border ${checked && skill.globalEnabled ? "border-accent bg-accent text-accent-ink" : "border-separator bg-bg"}`}>{checked && skill.globalEnabled && <Check size={12} />}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{skill.name}</span>
                    {!skill.globalEnabled ? <small className="text-label-3">{t("全局已停用")}</small> : !custom && <small className="text-accent">{t("仅使用")}</small>}
                  </button>;
                })}
                {inventory.skills.length === 0 && <small className="px-base py-loose text-caption text-label-3">{t("没有可用的 Skills")}</small>}
              </div>
            </section>

            <section className="border-t border-separator pt-card">
              <span className="mb-base flex items-center gap-base text-caption font-semibold text-label-2"><Cable size={14} />{t("MCP Servers")}<small className="ml-auto font-normal text-label-3">{draftServers.length} / {overview.servers.filter((server) => server.enabled).length}</small></span>
              <div className="grid gap-tight">
                {overview.servers.map((server) => {
                  const checked = draftServers.includes(server.key);
                  return <button className="flex min-h-[38px] items-center gap-base rounded-sm border-0 bg-transparent px-base text-left text-caption text-label-2 hover:bg-fill disabled:opacity-45" type="button" aria-pressed={checked} disabled={disabled || !server.enabled} onClick={() => toggleServer(server.key)} key={server.key}>
                    <span className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] border ${checked && server.enabled ? "border-accent bg-accent text-accent-ink" : "border-separator bg-bg"}`}>{checked && server.enabled && <Check size={12} />}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{server.name}</span>
                    <small className={!custom ? "text-accent" : "text-label-3"}>{t(!custom ? "仅使用" : server.scope)}</small>
                  </button>;
                })}
                {overview.servers.length === 0 && <small className="px-base py-loose text-caption text-label-3">{t("尚未配置 MCP Server")}</small>}
              </div>
            </section>
          </div>}

          <footer className="flex items-center justify-between gap-card border-t border-separator pt-card">
            <small className="max-w-[280px] text-caption leading-[1.45] text-label-3">{t(custom ? "更改会立即保存。" : "继承全局时点击任一资源，会立即切换为仅使用该资源。")}</small>
            {custom && <button className="inline-flex h-control-md shrink-0 items-center gap-base rounded-sm border border-separator bg-transparent px-loose text-caption font-semibold text-label-2 hover:bg-fill disabled:opacity-40" type="button" disabled={disabled} onClick={() => void saveSelection()}><RotateCcw size={13} />{t("恢复全局配置")}</button>}
          </footer>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SendControl({ isRunning, canSend, onStop }: { isRunning: boolean; canSend: boolean; onStop: () => void }) {
  const { t } = useI18n();
  if (isRunning) {
    return <button className={`${sendButtonBaseClass} bg-red text-white`} type="button" aria-label={t("停止 Agent")} onClick={onStop}><CircleStop size={16} /></button>;
  }
  return <button className={`${sendButtonBaseClass} bg-accent text-accent-ink`} type="submit" aria-label={t("发送")} disabled={!canSend}><ArrowUp size={16} /></button>;
}

function InitialComposer(props: NewChatViewProps) {
  const { t } = useI18n();
  const palette = useCommandPalette(props);
  const composer = useComposerAttachments(props);
  const canSend = Boolean(props.prompt.trim()) || hasComposerAttachments(props.attachments);
  return (
    <section className="relative z-[1] grid h-full w-full place-items-center pb-6" aria-label={t("新建对话")}>
      <div className="w-[min(760px,calc(100%-64px))]">
        <header className="mb-6 text-center">
          <div className="mx-auto mb-card w-fit"><BrandMark /></div>
          <h1 className="m-0 text-large-title font-semibold tracking-tight">{props.project ? t("在 {name} 中开始新对话", { name: props.project.name }) : t("今天想一起做什么？")}</h1>
          <p className="m-0 mt-base text-callout text-label-2">
            {props.project
              ? t("Pi 将以该目录为边界读取文件、执行命令并追踪变更。")
              : t("直接提问，或选择工作目录开始一个真实的 Agent 会话。")}
          </p>
        </header>

        <form className="composer-shell relative flex h-[184px] flex-col rounded-lg bg-bg-grouped p-card pb-tight shadow-2 transition-shadow duration-150 ease-apple" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }} onDrop={composer.onDrop} onDragOver={composer.onDragOver}>
          <AttachmentStrip attachments={props.attachments} onRemoveImage={composer.removeImage} onRemoveFile={composer.removeFile} />
          <textarea
            className="composer-input min-h-0 w-full flex-1 resize-none border-0 bg-transparent p-0 text-body leading-relaxed text-label outline-none placeholder:text-label-3"
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onPaste={composer.onPaste}
            onKeyDown={(event) => {
              const selectedCommand = palette.onKeyDown(event);
              if (selectedCommand === null) return;
              if (selectedCommand) {
                if (!props.isRunning) props.onSubmit(selectedCommand.name);
                return;
              }
              if (!shouldSubmitOnEnter(event.nativeEvent)) return;
              event.preventDefault();
              if (canSend && !props.isRunning) props.onSubmit();
            }}
            placeholder={t("描述你想分析、构建或修改的内容…")}
            aria-label={t("对话内容")}
          />
          <input ref={composer.fileInputRef} type="file" multiple hidden accept={attachmentAcceptTypes} tabIndex={-1} aria-hidden="true" onChange={composer.onFilePicked} />
          <CommandPalette matches={palette.matches} selected={palette.selected} placement="inside" onSelect={palette.select} />
          <div className="flex h-control-md flex-none items-end gap-base">
            <ModelSelector provider={props.modelProvider} modelId={props.modelId} providers={props.modelProviders} disabled={props.isRunning} onChange={props.onModelChange} />
            <AttachButton supportsImages={props.modelSupportsImages} onClick={composer.openPicker} />
            <SendControl isRunning={props.isRunning} canSend={canSend} onStop={props.onStop} />
          </div>
        </form>

        <div className="mt-loose grid min-h-[50px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-loose rounded-md border border-separator bg-bg-grouped px-loose py-base">
          <span className="flex items-center gap-base"><DirectoryMenu project={props.project} onProjectChange={props.onProjectChange} onChooseWorkspace={props.onChooseWorkspace} /><ProjectResourceMenu project={props.project} isRunning={props.isRunning} onResourcesChanged={props.onResourcesChanged} /></span>
          <span className="min-w-0">
            <strong className="block truncate text-callout font-semibold text-label">{props.project ? props.project.path : t("普通对话")}</strong>
            <small className="mt-tight block truncate text-caption text-label-3">{props.project ? t("Pi 工具将相对 {name} 运行", { name: props.project.name }) : t("未关联工作目录，Pi 使用隔离的空目录")}</small>
          </span>
          <button className={secondaryButtonClass} type="button" onClick={props.onOpenTerminal}><TerminalSquare size={14} />{t("终端")}</button>
        </div>
        <div className="mt-tight flex min-h-[30px] items-center gap-loose">
          <p className="m-0 flex-1 text-center text-caption text-label-3">{t("工作区内操作按权限模式执行；危险或越界行为仍会询问。")}</p>
          <ContextIndicator usage={props.contextUsage} budget={props.contextBudget} onOpenBudget={props.onOpenContextBudget} />
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
  const statusTone = toolStatusClass[activity.status];
  return (
    <Collapsible.Root className={`w-full overflow-hidden rounded-sm border transition-colors duration-150 ease-apple ${statusTone.root}`} defaultOpen={activity.status === "error"}>
      <Collapsible.Trigger className="group flex min-h-[31px] w-full cursor-pointer items-center gap-base border-0 bg-transparent px-[6px] text-left text-caption text-label-2">
        <Icon size={14} className={statusTone.icon} />
        <span className="font-semibold">{title}</span>
        <small className={`ml-auto text-caption font-semibold ${statusTone.label}`}>{t(activity.status === "running" ? "运行中" : activity.status === "success" ? "执行成功" : "执行失败")}</small>
        {activity.status === "running" ? <i className="activity-spinner" /> : activity.status === "success" ? <CheckCircle2 size={14} className="text-green" /> : <XCircle size={14} className="text-red" />}
        <ChevronDown size={14} className="text-label-3 transition-transform duration-150 ease-apple group-data-[state=open]:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Content className="grid gap-base px-[10px] pb-[10px]">
        {subagent && (
          <div className="min-w-0">
            <span className={toolSectionLabelClass}>{t("运行记录")}</span>
            <section className="grid gap-[7px] rounded-sm border border-separator bg-bg p-[9px]">
              <p className="m-0 flex items-center justify-between gap-[10px] text-caption text-label-2"><strong>{subagent.role}</strong><small className="font-mono text-caption text-label-3">{t(subagent.status === "running" ? "运行中" : subagent.status === "completed" ? "完成" : subagent.status === "stopped" ? "已停止" : "失败")}</small></p>
              <code className="font-mono text-caption text-label-3" title={subagent.sessionId}>{t("会话")} {subagent.sessionId.slice(0, 8)}</code>
              {subagent.usage && <ResponseUsageLine usage={subagent.usage} />}
              {subagent.error && <em className="font-mono not-italic text-caption text-red">{subagent.error}</em>}
            </section>
          </div>
        )}
        <div className="min-w-0"><span className={toolSectionLabelClass}>{t("输入")}</span><pre className={toolPreClass}>{formatData(activity.args)}</pre></div>
        {(activity.output || activity.status !== "running") && <div className="min-w-0"><span className={toolSectionLabelClass}>{t("输出")}</span><pre className={toolPreClass}>{activity.output || t("工具未返回文本")}</pre></div>}
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
  const failedCount = tools.filter((tool) => tool.status === "error").length;
  const failed = failedCount > 0;
  const title = tools.length === 0
    ? t("分析过程")
    : allCommands
      ? running
        ? t(tools.length > 1 ? "正在运行多个命令" : "正在运行命令")
        : failed
          ? tools.length > 1 ? t("{failed} / {total} 个命令执行失败", { failed: failedCount, total: tools.length }) : t("命令执行失败")
          : tools.length > 1 ? t("{count} 个命令执行成功", { count: tools.length }) : t("命令执行成功")
      : running
        ? tools.length > 1 ? t("正在调用多个工具") : `${t("运行中")} · ${t(toolLabel(tools[0].name))}`
        : failed
          ? tools.length > 1 ? t("{failed} / {total} 个工具执行失败", { failed: failedCount, total: tools.length }) : `${t("执行失败")} · ${t(toolLabel(tools[0].name))}`
          : tools.length > 1 ? t("{count} 个工具执行成功", { count: tools.length }) : `${t("执行成功")} · ${t(toolLabel(tools[0].name))}`;

  const groupTone = running ? "text-accent" : failed ? "text-red" : "text-green";

  return (
    <Collapsible.Root className="w-full text-label-3" defaultOpen={failed}>
      <Collapsible.Trigger className={`group flex min-h-[34px] w-full cursor-pointer items-center gap-base border-0 bg-transparent p-[3px] text-left text-caption transition-colors duration-150 ease-apple ${groupTone}`}>
        <TerminalSquare size={16} />
        <span className="font-semibold">{title}</span>
        {running ? <i className="activity-spinner ml-auto" /> : failed ? <XCircle size={14} className="ml-auto" /> : <CheckCircle2 size={14} className="ml-auto" />}
        <ChevronDown size={14} className="text-label-3 transition-transform duration-150 ease-apple group-data-[state=open]:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Content className="grid gap-[2px] pb-tight pl-[22px]">
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
    <section className="w-full overflow-hidden rounded-md border border-orange/32 bg-orange/8 p-loose">
      <header className="flex items-center gap-[7px] text-caption text-orange"><MessageCircleQuestion size={16} /><strong>{t("Pi 需要你的回答")}</strong></header>
      <p className="my-[10px] whitespace-pre-wrap text-caption leading-[1.6] text-label-2">{activity.question}</p>
      {activity.status === "answered" ? (
        <div className="flex items-center gap-[6px] text-caption text-green"><Check size={14} />{activity.answer}</div>
      ) : (
        <>
          {activity.options.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-[7px]">
              {activity.options.map((option) => (
                <button className="min-h-[45px] cursor-pointer rounded-sm border border-separator bg-bg px-[9px] py-base text-left text-label-2 transition-colors duration-150 ease-apple hover:border-orange" key={option.label} type="button" onClick={() => onAnswer(turnId, activity.id, option.label)}>
                  <strong className="block text-caption">{option.label}</strong>
                  {option.description && <small className="mt-[3px] block text-caption text-label-3">{option.description}</small>}
                </button>
              ))}
            </div>
          )}
          <form className="mt-base flex gap-[7px]" onSubmit={(event) => {
            event.preventDefault();
            if (customAnswer.trim()) onAnswer(turnId, activity.id, customAnswer.trim());
          }}>
            <input className="h-control-md min-w-0 flex-1 rounded-sm border border-separator bg-bg px-[9px] text-caption text-label outline-none" value={customAnswer} onChange={(event) => setCustomAnswer(event.target.value)} placeholder={t("输入其他回答…")} />
            <button className="cursor-pointer rounded-sm border-0 bg-accent px-loose text-caption font-bold text-accent-ink disabled:pointer-events-none disabled:opacity-40" type="submit" disabled={!customAnswer.trim()}>{t("提交")}</button>
          </form>
        </>
      )}
    </section>
  );
}

const MessageActivity = memo(function MessageActivity({ text, onOpenLink, onOpenExternalLink }: {
  text: string;
  onOpenLink: NewChatViewProps["onOpenLink"];
  onOpenExternalLink: NewChatViewProps["onOpenExternalLink"];
}) {
  if (!text) return null;
  return <MarkdownNavigationContext.Provider value={{ onOpenLink, onOpenExternalLink }}>
    <div className="markdown-content mt-[3px] w-full max-w-full overflow-hidden rounded-md rounded-tl-sm border border-accent/16 bg-accent/8 px-[13px] py-[11px] text-left text-body leading-[1.75] text-label-2"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{text}</Markdown></div>
  </MarkdownNavigationContext.Provider>;
}, (previous, next) => previous.text === next.text);

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

  const statusTone = waitingForAnswer
    ? { bar: "border-orange/32", signal: "bg-orange/8 text-orange", label: "text-orange" }
    : { bar: "border-accent/32", signal: "bg-accent/8 text-accent", label: "text-accent" };
  return <div className={`task-status-bar relative mx-auto mb-[9px] grid min-h-[54px] w-[min(760px,100%)] grid-cols-[30px_minmax(0,1fr)_auto_auto] items-center gap-[10px] overflow-hidden rounded-md border bg-bg-grouped py-base pl-loose pr-[9px] shadow-2 ${statusTone.bar}`}>
    <span className={`task-status-signal flex size-[28px] items-center justify-center gap-[3px] rounded-sm ${statusTone.signal}`} aria-hidden="true"><i /><i /><i /></span>
    <span className="grid min-w-0 gap-[2px]" role="status" aria-live="polite">
      <small className={`text-caption font-bold tracking-[0.07em] ${statusTone.label}`}>{t(waitingForAnswer ? "等待你的输入" : "任务进行中")}</small>
      <strong className="truncate text-caption font-semibold text-label-2">{phase}</strong>
    </span>
    <time className="whitespace-nowrap font-mono text-caption text-label-3 tabular-nums" title={t("任务运行时长")} aria-hidden="true">{formatElapsedTime(elapsedSeconds, t)}</time>
    <button className="inline-flex h-control-md cursor-pointer items-center gap-[6px] rounded-sm border border-red/32 bg-red/8 px-[9px] text-caption text-red transition-colors duration-150 ease-apple hover:bg-red/16 active:scale-[0.98]" type="button" onClick={onStop}><CircleStop size={14} />{t("停止任务")}</button>
  </div>;
}

function ActivityTimeline({
  turn,
  onAnswerQuestion,
  onOpenLink,
  onOpenExternalLink,
}: {
  turn: ChatTurn;
  onAnswerQuestion: NewChatViewProps["onAnswerQuestion"];
  onOpenLink: NewChatViewProps["onOpenLink"];
  onOpenExternalLink: NewChatViewProps["onOpenExternalLink"];
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
    if (turn.answer) return <MessageActivity text={turn.answer} onOpenLink={onOpenLink} onOpenExternalLink={onOpenExternalLink} />;
    return turn.status === "running" ? <div className="flex items-center gap-base rounded-md bg-bg-grouped px-loose py-[10px] text-caption text-label-3"><i className="activity-spinner" />{t("Pi 正在分析任务…")}</div> : null;
  }

  return (
    <>
      {timeline.map((item) => {
        if (item.type === "tools") return <ToolGroup key={item.key} tools={item.tools} />;
        if (item.activity.type === "message") return <MessageActivity key={item.activity.id} text={item.activity.text} onOpenLink={onOpenLink} onOpenExternalLink={onOpenExternalLink} />;
        if (item.activity.type === "thinking") return <MessageActivity key={item.activity.id} text={item.activity.text} onOpenLink={onOpenLink} onOpenExternalLink={onOpenExternalLink} />;
        return <QuestionActivity key={item.activity.id} turnId={turn.id} activity={item.activity} onAnswer={onAnswerQuestion} />;
      })}
      {!hasMessages && turn.answer && <MessageActivity text={turn.answer} onOpenLink={onOpenLink} onOpenExternalLink={onOpenExternalLink} />}
    </>
  );
}

const ConversationTurn = memo(function ConversationTurn({ turn, running, onRetry, onForkTurn, onAnswerQuestion, onOpenLink, onOpenExternalLink, onOpenChange, onAcceptChanges, onRevertChanges }: {
  turn: ChatTurn;
  running: boolean;
  onRetry: (turnId: string) => void;
  onForkTurn: NewChatViewProps["onForkTurn"];
  onAnswerQuestion: NewChatViewProps["onAnswerQuestion"];
  onOpenLink: NewChatViewProps["onOpenLink"];
  onOpenExternalLink: NewChatViewProps["onOpenExternalLink"];
  onOpenChange: (change: TaskFileChange) => void;
  onAcceptChanges: NewChatViewProps["onAcceptChanges"];
  onRevertChanges: NewChatViewProps["onRevertChanges"];
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const queueStatus = turn.status === "queued"
    ? `${t(turn.queueMode === "steer" ? "立即调整" : "稍后继续")} · ${t("等待执行")}`
    : turn.status === "cancelled" ? t("未执行") : null;
  async function copyQuestion() {
    await navigator.clipboard.writeText(turn.question);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <article className="relative mb-[34px]">
      <section className="relative ml-auto flex w-[86%] items-start justify-end pb-[31px]" aria-label={t("用户消息")}>
        <div className="w-fit max-w-full">
          {turn.attachments && turn.attachments.length > 0 && (
            <div className="mb-[6px] ml-auto flex w-fit max-w-full flex-wrap justify-end gap-[6px]">
              {turn.attachments.map((attachment, index) => attachment.kind === "image" && attachment.dataUrl
                ? <img className="max-h-[140px] max-w-[200px] rounded-sm border border-separator object-cover" src={attachment.dataUrl} alt={attachment.name} title={attachment.name} key={`${attachment.name}-${index}`} />
                : <span className="inline-flex h-[28px] items-center gap-tight rounded-full border border-separator bg-bg-grouped px-base text-caption text-label-2" title={attachment.name} key={`${attachment.name}-${index}`}><FileBox size={12} className="text-accent" /><span className="max-w-[180px] truncate">{attachment.name}</span>{attachment.access && <span className="text-label-3">{t(attachment.access === "inline" ? "直接附加" : "按需读取")}</span>}</span>)}
            </div>
          )}
          {turn.question && <div className={`mt-[3px] ml-auto w-fit max-w-full rounded-md rounded-tr-sm border bg-bg-grouped px-[13px] py-[11px] text-body leading-[1.65] text-label-2 ${turn.status === "queued" ? "border-accent/32" : "border-separator"}`}>{turn.question}</div>}
          <div className="absolute right-0 bottom-0 flex items-center gap-tight">
            {queueStatus && <span className={`mr-base inline-flex items-center gap-[5px] text-caption ${turn.status === "queued" ? "text-accent" : "text-label-3"}`} role="status"><Clock3 size={13} />{queueStatus}</span>}
            <button className={messageActionButtonClass} type="button" onClick={() => void copyQuestion()} aria-label={t("复制用户输入")}>
              {copied ? <Check size={14} /> : <Copy size={14} />}<span>{t(copied ? "已复制" : "复制")}</span>
            </button>
            <button className={messageActionButtonClass} type="button" onClick={() => onRetry(turn.id)} disabled={running || turn.status === "queued"}>
              <RotateCcw size={14} /><span>{t("重试")}</span>
            </button>
            {turn.sessionEntryId && <button className={messageActionButtonClass} type="button" onClick={() => onForkTurn(turn.sessionEntryId!)} disabled={running}>
              <GitFork size={14} /><span>{t("从此处 Fork")}</span>
            </button>}
          </div>
        </div>
      </section>
      {turn.status !== "queued" && turn.status !== "cancelled" && <section className="relative mt-[19px] flex w-[86%] items-start justify-start" aria-label={t("Agent 回答")}>
        <div className="grid w-full gap-[9px]">
          <ActivityTimeline turn={turn} onAnswerQuestion={onAnswerQuestion} onOpenLink={onOpenLink} onOpenExternalLink={onOpenExternalLink} />
          {turn.usage && <ResponseUsageLine usage={turn.usage} />}
          {turn.status === "error" && <div className="flex items-center gap-base rounded-md bg-red/8 px-loose py-[10px] text-caption text-red"><XCircle size={14} />{turn.error}</div>}
          {turn.status === "stopped" && <div className="flex items-center gap-base rounded-md bg-bg-grouped px-loose py-[10px] text-caption text-orange">{t("任务已停止")}</div>}
        </div>
      </section>}
      <FileChangesPanel changes={turn.fileChanges ?? []} running={running} onOpen={onOpenChange} onAccept={onAcceptChanges} onRevert={onRevertChanges} />
    </article>
  );
}, (previous, next) => previous.turn === next.turn && previous.running === next.running);

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
  return <Collapsible.Root className="mx-auto mt-card w-[min(760px,100%)] overflow-hidden rounded-md border border-separator bg-bg-grouped shadow-1" defaultOpen>
    <header className="flex min-h-[42px] items-center justify-between gap-loose pl-loose pr-[9px]">
      <Collapsible.Trigger className="group flex min-w-0 cursor-pointer items-center gap-[7px] border-0 bg-transparent text-caption text-label-2"><FileDiff size={14} className="text-accent" /><strong>{t("改动的文件")}</strong><span className="min-w-[17px] rounded-full bg-fill-2 px-[5px] py-[2px] text-caption text-label-3">{changes.length}</span><ChevronDown size={14} className="transition-transform duration-150 ease-apple group-data-[state=open]:rotate-180" /></Collapsible.Trigger>
      {pending.length > 0 && <div className="flex items-center gap-[5px]"><button className={panelHeaderButtonClass} type="button" onClick={() => onAccept(pending.map((change) => change.id))}><ShieldCheck size={14} />{t("全部接受")}</button><button className={panelHeaderButtonClass} type="button" disabled={running || pending.some((change) => !change.revertible)} onClick={() => onRevert(pending.map((change) => change.id))}><Undo2 size={14} />{t("全部回退")}</button></div>}
    </header>
    <Collapsible.Content className="max-h-[min(42vh,392px)] overflow-auto border-t border-separator [scrollbar-width:thin]">
      {changes.map((change) => <div key={change.id} className="relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center border-t border-separator transition-colors duration-150 ease-apple first:border-t-0 hover:bg-fill">
        <button className="flex min-h-[42px] min-w-0 cursor-pointer items-center gap-[7px] border-0 bg-transparent pr-[6px] pl-loose text-left text-label-3 transition-colors duration-150 ease-apple hover:text-label-2" type="button" onClick={() => onOpen(change)} title={t("在右侧查看 Diff")}>
          {isArtifactChange(change) ? <FileBox size={14} className="shrink-0 text-accent" /> : <FileDiff size={14} className="shrink-0 text-accent" />}
          <code className="min-w-0 flex-1 truncate font-mono text-caption text-label-2">{change.relativePath}</code>
          {isArtifactChange(change) && <span className="shrink-0 rounded-full bg-accent/8 px-[6px] py-[3px] text-caption text-accent">{t("成果物")}</span>}
          <span className="shrink-0 text-caption text-label-3">{t(change.kind === "created" ? "新建" : "修改")}</span><em className={`shrink-0 text-caption not-italic ${changeStatusClass[change.status]}`}>{t(change.status)}</em>
        </button>
        {change.status === "pending" && <div className="flex items-center gap-[5px] pr-[10px] pl-tight">
          <button className="inline-flex min-h-control-sm cursor-pointer items-center justify-center gap-tight rounded-sm border border-separator bg-bg-grouped px-base py-tight text-caption text-label-2 transition-colors duration-150 ease-apple hover:bg-fill-2 active:scale-[0.98]" type="button" onClick={() => onAccept([change.id])}><Check size={14} />{t("接受")}</button>
          {change.revertible
            ? <button className="inline-flex min-h-control-sm w-control-sm cursor-pointer items-center justify-center gap-tight rounded-sm border border-separator bg-transparent px-0 py-tight text-caption text-label-3 transition-colors duration-150 ease-apple hover:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={running} onClick={() => onRevert([change.id])} aria-label={t("回退")} title={t("回退")}><Undo2 size={14} /></button>
            : <span className="grid size-control-sm place-items-center text-label-4" aria-label={t("无法自动回退")} title={t("无法自动回退")}><Undo2 size={14} /></span>}
        </div>}
        {change.error && <p className="col-span-full m-0 pr-loose pb-[9px] pl-[32px] text-caption text-red">{change.error}</p>}
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

  return <aside className="relative z-[3] grid min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden border-l border-separator bg-bg-grouped shadow-2 max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:left-auto max-[1100px]:w-[min(540px,calc(100%-18px))] max-[1100px]:shadow-3" aria-label={t("文件变更详情")}>
    <header className="flex min-h-[58px] items-center justify-between gap-loose border-b border-separator bg-bg-grouped-2 py-[9px] pr-[10px] pl-[14px]">
      <div className="flex min-w-0 flex-1 items-center gap-[9px]">{isArtifact ? <FileBox size={16} className="shrink-0 text-accent" /> : <FileDiff size={16} className="shrink-0 text-accent" />}<span className="flex min-w-0 flex-col items-start gap-[3px]"><strong className="text-caption tracking-[0.02em] text-label">{isArtifact ? t("成果物") : "Diff"}</strong><code className="max-w-full truncate font-mono text-caption text-label-3" title={change.path}>{change.relativePath}</code></span></div>
      <div className="flex shrink-0 items-center gap-[3px]">
        <button className={messageActionButtonClass} type="button" disabled={action !== null} onClick={() => void performAction("open")} title={t("使用系统默认应用打开")}><ExternalLink size={14} /><span>{t("打开")}</span></button>
        <button className={messageActionButtonClass} type="button" disabled={action !== null} onClick={() => void performAction("reveal")} title={t("在文件管理器中显示")}><FolderOpen size={14} /><span>{t("定位")}</span></button>
        <button className={messageActionButtonClass} type="button" onClick={onClose} aria-label={t("关闭文件变更详情")}><X size={16} /></button>
      </div>
    </header>
    <div className="flex min-h-[35px] items-center gap-[6px] overflow-hidden border-b border-separator px-[14px]"><span className="shrink-0 rounded-full bg-fill px-[6px] py-[3px] text-mini text-label-3">{t(change.kind === "created" ? "新建" : "修改")}</span><span className={`shrink-0 rounded-full bg-fill px-[6px] py-[3px] text-mini ${changeStatusClass[change.status]}`}>{t(change.status)}</span><code className="ml-auto min-w-0 truncate font-mono text-caption text-label-3" title={change.path}>{change.path}</code></div>
    {isArtifact ? <div className="flex min-h-0 min-w-0 flex-col items-center justify-center overflow-auto p-[34px] text-center">
      <div className="relative mb-[18px] grid h-[78px] w-[72px] place-items-center rounded-lg border border-accent/32 bg-accent/8 text-accent shadow-2"><FileBox size={30} /><span className="absolute inset-x-[7px] bottom-[7px] truncate rounded-sm bg-accent p-[3px] font-mono text-mini font-bold text-accent-ink">{fileExtension(change.relativePath)}</span></div>
      <strong className="text-headline text-label">{t("成果物已生成")}</strong>
      <p className="m-0 mt-[9px] mb-[15px] max-w-[42ch] text-caption leading-[1.65] text-label-3">{t("该文件是二进制文件或体积较大，无法显示文本 Diff。你可以直接打开，或在文件管理器中定位。")}</p>
      <code className="max-w-[min(520px,100%)] truncate rounded-sm border border-separator bg-bg px-[10px] py-base font-mono text-caption text-label-2">{change.path}</code>
      <div className="mt-[18px] flex flex-wrap justify-center gap-[7px]"><button className="inline-flex h-control-lg cursor-pointer items-center gap-[6px] rounded-sm border border-transparent bg-accent px-[11px] text-caption text-accent-ink transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={action !== null} onClick={() => void performAction("open")}><ExternalLink size={14} />{action === "open" ? t("正在打开…") : t("打开成果物")}</button><button className="inline-flex h-control-lg cursor-pointer items-center gap-[6px] rounded-sm border border-separator bg-bg-grouped-2 px-[11px] text-caption text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={action !== null} onClick={() => void performAction("reveal")}><FolderOpen size={14} />{action === "reveal" ? t("正在定位…") : t("在文件管理器中显示")}</button></div>
    </div> : <pre className="m-0 min-h-0 min-w-0 overflow-auto bg-bg pt-[10px] pb-[28px] font-mono text-caption leading-[1.65] text-label-2 [tab-size:2]" aria-label={t("文件 Diff")}>{change.patch.split("\n").map((line, index) => <span className={`grid min-w-max grid-cols-[44px_minmax(max-content,1fr)] whitespace-pre ${line.startsWith("+") && !line.startsWith("+++") ? "bg-green/8 text-label-2" : line.startsWith("-") && !line.startsWith("---") ? "bg-red/8 text-label-2" : line.startsWith("@@") ? "my-[6px] bg-blue/8 text-label-2" : line.startsWith("---") || line.startsWith("+++") ? "font-semibold text-accent" : ""}`} key={`${index}:${line}`}><i className="pr-[10px] pl-[6px] text-right not-italic text-label-3 select-none">{index + 1}</i><code className="pr-[18px]">{line || " "}</code></span>)}</pre>}
    {(change.error || actionError) && <p className="m-0 flex items-center gap-[7px] border-t border-red/32 bg-red/8 px-[14px] py-[10px] text-caption text-red"><XCircle size={14} />{actionError || change.error}</p>}
  </aside>;
}

function ActiveConversation(props: NewChatViewProps & { onOpenChange: (change: TaskFileChange) => void }) {
  const { t } = useI18n();
  const palette = useCommandPalette(props);
  const composer = useComposerAttachments(props);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const historyContentRef = useRef<HTMLDivElement | null>(null);
  const followsLatestRef = useRef(true);
  const announcementSnapshotRef = useRef(conversationAnnouncementSnapshot(props.turns));
  const restoreScrollHeightRef = useRef<number | null>(null);
  const [followsLatest, setFollowsLatest] = useState(true);
  const [hasUnreadContent, setHasUnreadContent] = useState(false);
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });
  const [visibleTurnStart, setVisibleTurnStart] = useState(() => Math.max(0, props.turns.length - initialVisibleTurnCount));
  const canSend = Boolean(props.prompt.trim()) || hasComposerAttachments(props.attachments);
  const runningTurn = [...props.turns].reverse().find((turn) => turn.status === "running");
  const steeringCount = props.queuedMessages.steering.length;
  const followUpCount = props.queuedMessages.followUp.length;
  const queuedCount = steeringCount + followUpCount;

  useLayoutEffect(() => {
    const history = historyRef.current;
    const previousHeight = restoreScrollHeightRef.current;
    if (!history || previousHeight === null) return;
    history.scrollTop += history.scrollHeight - previousHeight;
    restoreScrollHeightRef.current = null;
  }, [visibleTurnStart]);

  useEffect(() => {
    const kind = nextConversationAnnouncement(announcementSnapshotRef.current, props.turns);
    announcementSnapshotRef.current = conversationAnnouncementSnapshot(props.turns);
    const text = kind === "question"
      ? t("Pi 需要你的回答")
      : kind === "completed"
        ? t("任务已完成")
        : kind === "stopped"
          ? t("任务已停止")
          : kind === "error"
            ? t("任务执行失败")
            : "";
    if (text) setAnnouncement((current) => ({ id: current.id + 1, text }));
  }, [props.turns, t]);

  useEffect(() => {
    const history = historyRef.current;
    const content = historyContentRef.current;
    if (!history || !content) return;
    let frame = 0;
    const scheduleLatest = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        history.scrollTop = history.scrollHeight;
        followsLatestRef.current = true;
        setFollowsLatest(true);
        setHasUnreadContent(false);
      });
    };
    const contentChanged = () => {
      if (followsLatestRef.current) scheduleLatest();
      else setHasUnreadContent(true);
    };
    const mutationObserver = new MutationObserver(contentChanged);
    mutationObserver.observe(content, { childList: true, characterData: true, subtree: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(contentChanged);
    resizeObserver?.observe(content);
    scheduleLatest();
    return () => {
      window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, []);

  function onHistoryScroll() {
    const history = historyRef.current;
    if (!history) return;
    const nearLatest = isNearConversationBottom(history.scrollHeight, history.scrollTop, history.clientHeight);
    followsLatestRef.current = nearLatest;
    setFollowsLatest(nearLatest);
    if (nearLatest) setHasUnreadContent(false);
  }

  function scrollToLatest() {
    const history = historyRef.current;
    if (!history) return;
    followsLatestRef.current = true;
    history.scrollTop = history.scrollHeight;
    setFollowsLatest(true);
    setHasUnreadContent(false);
  }

  function loadEarlierTurns() {
    const history = historyRef.current;
    if (history) restoreScrollHeightRef.current = history.scrollHeight;
    setVisibleTurnStart((current) => Math.max(0, current - earlierTurnBatchSize));
  }

  return (
    <section className="relative z-[1] grid h-full w-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]" aria-label={t("当前对话")}>
      <div className="relative min-h-0">
        <div ref={historyRef} className="h-full min-h-0 overflow-auto px-[54px] pt-[42px] pb-[22px] [scrollbar-width:thin] [scrollbar-color:var(--fill-3)_transparent]" onScroll={onHistoryScroll}>
          <div ref={historyContentRef} className="mx-auto w-[min(760px,100%)]">
            {visibleTurnStart > 0 && <button className="mx-auto mb-card flex h-control-md cursor-pointer items-center rounded-full border border-separator bg-bg-grouped px-loose text-caption text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label-2" type="button" onClick={loadEarlierTurns}>{t("加载更早的 {count} 条消息", { count: Math.min(earlierTurnBatchSize, visibleTurnStart) })}</button>}
            {props.turns.slice(visibleTurnStart).map((turn) => <ConversationTurn key={turn.id} turn={turn} running={props.isRunning} onRetry={props.onRetry} onForkTurn={props.onForkTurn} onAnswerQuestion={props.onAnswerQuestion} onOpenLink={props.onOpenLink} onOpenExternalLink={props.onOpenExternalLink} onOpenChange={props.onOpenChange} onAcceptChanges={props.onAcceptChanges} onRevertChanges={props.onRevertChanges} />)}
            <PlanReviewPanel reviews={props.planReviews} onResolve={props.onResolvePlanReview} />
          </div>
        </div>
        {!followsLatest && <button className="absolute right-[22px] bottom-[12px] inline-flex h-control-md cursor-pointer items-center gap-base rounded-full border border-separator bg-bg-grouped px-loose text-caption text-label-2 shadow-2 transition-colors duration-150 ease-apple hover:bg-fill" type="button" onClick={scrollToLatest}>
          {hasUnreadContent && <span className="size-[7px] rounded-full bg-accent" aria-hidden="true" />}{t(hasUnreadContent ? "有新内容 · 回到最新" : "回到最新")}
        </button>}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement.text && <span key={announcement.id}>{announcement.text}</span>}</div>
      <footer className="relative bg-linear-to-b from-transparent via-20% via-bg to-bg px-[52px] pt-[14px] pb-[17px]">
        {props.isRunning && runningTurn && <RunningTaskStatus turn={runningTurn} onStop={props.onStop} />}
        {queuedCount > 0 && <div className="mx-auto mb-[7px] flex min-h-[28px] w-[min(760px,100%)] items-center gap-base rounded-sm border border-accent/16 bg-accent/8 px-base text-caption text-label-3" aria-live="polite"><Clock3 size={13} className="shrink-0 text-accent" /><strong className="font-semibold text-accent">{t("已排队 {count} 条消息", { count: queuedCount })}</strong>{steeringCount > 0 && <small>{t("立即调整")} {steeringCount}</small>}{followUpCount > 0 && <small>{t("稍后继续")} {followUpCount}</small>}<button className="ml-auto cursor-pointer border-0 bg-transparent text-caption text-label-3 transition-colors duration-150 ease-apple hover:text-label-2" type="button" onClick={props.onClearQueue}>{t("清空队列")}</button></div>}
        <form className="composer-shell relative mx-auto flex h-[108px] w-[min(760px,100%)] flex-col rounded-lg bg-bg-grouped px-[14px] pt-loose pb-tight shadow-2 transition-shadow duration-150 ease-apple" onSubmit={(event) => {
          event.preventDefault();
          if (props.isRunning) props.onQueue("followUp");
          else props.onSubmit();
        }} onDrop={composer.onDrop} onDragOver={composer.onDragOver}>
          <AttachmentStrip attachments={props.attachments} onRemoveImage={composer.removeImage} onRemoveFile={composer.removeFile} />
          <textarea
            className="composer-input min-h-0 w-full flex-1 resize-none border-0 bg-transparent px-[3px] py-0 text-body leading-relaxed text-label outline-none placeholder:text-label-3"
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onPaste={composer.onPaste}
            onKeyDown={(event) => {
              const selectedCommand = palette.onKeyDown(event);
              if (selectedCommand === null) return;
              if (selectedCommand) {
                if (props.isRunning) props.onQueue("followUp", selectedCommand.name);
                else props.onSubmit(selectedCommand.name);
                return;
              }
              if (!shouldSubmitOnEnter(event.nativeEvent)) return;
              event.preventDefault();
              if (!canSend) return;
              if (props.isRunning) props.onQueue("followUp");
              else props.onSubmit();
            }}
            placeholder={t(props.isRunning ? "输入调整指令，选择立即介入或稍后继续…" : "继续给 Pi 指令…")}
            aria-label={t("继续对话")}
          />
          <input ref={composer.fileInputRef} type="file" multiple hidden accept={attachmentAcceptTypes} tabIndex={-1} aria-hidden="true" onChange={composer.onFilePicked} />
          <CommandPalette matches={palette.matches} selected={palette.selected} placement="above" onSelect={palette.select} />
          <div className="flex h-control-md flex-none items-end gap-base">
            <ModelSelector provider={props.modelProvider} modelId={props.modelId} providers={props.modelProviders} disabled={props.isRunning} onChange={props.onModelChange} />
            <AttachButton supportsImages={props.modelSupportsImages} onClick={composer.openPicker} />
            <DirectoryMenu compact project={props.project} onProjectChange={props.onProjectChange} onChooseWorkspace={props.onChooseWorkspace} />
            <ProjectResourceMenu compact project={props.project} isRunning={props.isRunning} onResourcesChanged={props.onResourcesChanged} />
            <button className={composerToolButtonClass} type="button" onClick={props.onOpenTerminal} aria-label={t("打开终端")} title={t("打开终端")}><TerminalSquare size={14} /></button>
            {props.isRunning && <><button className={queueButtonClass} type="button" disabled={!canSend} onClick={() => props.onQueue("steer")}>{t("立即调整")}</button><button className={queueButtonClass} type="submit" disabled={!canSend}>{t("稍后继续")}</button></>}
            <SendControl isRunning={props.isRunning} canSend={canSend} onStop={props.onStop} />
          </div>
        </form>
        <div className="mx-auto mt-base flex min-h-[17px] w-[min(760px,100%)] items-center gap-base text-caption text-label-3">
          <span className="inline-flex min-w-0 items-center gap-base truncate">{props.project ? <><Folder size={14} /><code className="font-mono text-caption text-accent">{props.project.path}</code></> : <>{t("普通对话 · 隔离目录")}</>}</span>
          <ContextIndicator usage={props.contextUsage} budget={props.contextBudget} className="ml-auto" onOpenBudget={props.onOpenContextBudget} />
        </div>
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
  return <div className={`relative grid h-full w-full min-h-0 min-w-0 overflow-hidden ${selectedChange ? "grid-cols-[minmax(420px,1fr)_minmax(360px,44%)] max-[1100px]:grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]"}`}>
    <ActiveConversation key={props.turns[0]?.id} {...props} onOpenChange={(change) => setSelectedChangeId(change.id)} />
    {selectedChange && <FileChangeInspector change={selectedChange} onClose={() => setSelectedChangeId(null)} />}
  </div>;
}
