import {
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  PackageCheck,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n, type Translate } from "../i18n";
import type {
  InstalledPlugin,
  PackageCapabilityProvider,
  PluginPackage,
  PluginProgressEvent,
  PluginResourceType,
  PluginRiskTier,
  PluginRuntimeStatus,
  SubagentProvider,
} from "../contracts";

type PluginsPanelProps = {
  agentRunning: boolean;
  workspaceCwd?: string;
};

/* 插件中心工具类组合（token v2，docs-internal/design-refresh-apple.md 3.2/3.5）：
   badge 语义色 16% 底 + 本色文字（alpha 仅 8/16/32 档）；
   卡片去边框改 bg-bg-grouped 填充分层，内层用 bg-bg；按钮 13px/600 走 control 高度档。 */
const primaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-[6px] rounded-sm border-0 bg-accent px-card text-body font-semibold text-accent-ink transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const secondaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-separator bg-bg-grouped-2 px-card text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const nativeSelectClass =
  "h-control-lg w-full cursor-pointer appearance-none rounded-sm border border-separator bg-fill pr-8 pl-[11px] text-body text-label outline-none focus-visible:ring-2 focus-visible:ring-accent/32";
const nativeSelectChevronClass = "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-label-3";
const pluginErrorClass = "mt-[14px] rounded-sm border border-red/32 bg-red/8 px-loose py-[10px] text-caption text-red";

const badgeBaseClass = "inline-flex items-center rounded-full px-2 py-0.5 text-mini";
const compatibilityBadgeClass: Record<PluginPackage["compatibility"], string> = {
  desktop: "bg-green/16 text-green",
  review: "bg-orange/16 text-orange",
  unknown: "bg-fill text-label-2",
};
const riskBadgeClass: Record<PluginRiskTier, string> = {
  low: "bg-green/16 text-green",
  medium: "bg-orange/16 text-orange",
  high: "bg-orange/16 text-orange",
  blocked: "bg-red/16 text-red",
};

const pluginTabClass = (active: boolean) =>
  active
    ? "relative h-control-lg cursor-pointer px-loose text-body font-semibold text-label transition-colors duration-150 ease-apple after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent"
    : "relative h-control-lg cursor-pointer px-loose text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:text-label";

const pluginIconClass = "grid size-[34px] flex-none place-items-center rounded-md bg-accent/16 text-accent";
const pluginCardHeaderClass = "grid min-w-0 grid-cols-[38px_minmax(0,1fr)] items-center gap-[11px]";
const pluginNameClass = "block wrap-anywhere font-mono text-body font-semibold text-label";
const pluginSublineClass = "mt-1 block truncate text-caption text-label-3";

const capabilityCardClass = "mb-[14px] rounded-md bg-bg-grouped p-card";
const capabilityCardHeaderClass = "flex items-center justify-between gap-[14px]";
const capabilityCardTitleClass = "block text-body font-semibold text-label";
const capabilityCardNoteClass = "mt-[5px] block text-caption text-label-3";
const capabilityCardFooterClass = "mt-[14px] flex items-center justify-between gap-[14px] border-t border-separator pt-[13px]";
const capabilityStateClass = (fallback: boolean) =>
  fallback
    ? "flex-none rounded-full bg-orange/16 px-2 py-0.5 font-mono text-mini text-orange"
    : "flex-none rounded-full bg-green/16 px-2 py-0.5 font-mono text-mini text-green";
const capabilityToolFieldClass = "mt-loose grid gap-[6px]";
const capabilityToolLabelClass = "text-caption font-semibold text-label-2";
const capabilityToolNoteClass = "text-caption text-label-3";

const pluginEmptyClass = "grid min-h-[190px] place-items-center content-center gap-base rounded-md border border-dashed border-separator text-label-3";

const pluginPurposeSectionClass = "rounded-md bg-bg p-card";
const pluginSectionHeaderClass = "mb-[11px] flex items-baseline justify-between gap-loose";
const pluginSectionTitleClass = "text-body font-semibold text-label";
const pluginSectionNoteClass = "text-caption text-label-3";
const pluginStepListClass = "m-0 grid list-none gap-[7px] p-0";
const pluginStepItemClass = "grid grid-cols-[20px_minmax(0,1fr)] items-start gap-base text-caption leading-[1.5] text-label-2";

const resourceLabels: Record<PluginResourceType, string> = {
  extensions: "扩展资源",
  skills: "技能资源",
  prompts: "提示词资源",
  themes: "主题资源",
};

function errorMessage(error: unknown, t: Translate): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered for 'plugins:runtime'") || message.includes("plugins.runtime is not a function")) {
    return t("Electron 主进程仍在运行旧版本。请完全退出并重新启动 Pi Desktop，插件运行时接口会在启动时注册。");
  }
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function compactNumber(value?: number, locale = "zh-CN"): string | undefined {
  if (value === undefined) return undefined;
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function compatibilityCopy(plugin: PluginPackage): string {
  if (plugin.compatibility === "desktop") return "桌面兼容";
  if (plugin.compatibility === "review") return "含 Extension，需确认 UI 兼容性";
  return "兼容性未知";
}

function capabilityCopies(plugin: PluginPackage): string[] {
  const copies: string[] = [];
  if (plugin.resources.includes("extensions")) copies.push("调用插件新增的工具或命令，扩展 Agent 可以执行的操作。");
  if (plugin.resources.includes("skills")) copies.push("让 Agent 按插件内置的专业流程处理相关任务。");
  if (plugin.resources.includes("prompts")) copies.push("使用插件提供的预设提示词，更快启动重复性任务。");
  if (plugin.resources.includes("themes")) copies.push("使用插件附带的主题资源调整支持的界面外观。");
  return copies.length > 0 ? copies : ["该包未声明具体能力；安装后 Pi 会尝试自动发现可用资源。"];
}

function usageCopies(plugin: PluginPackage, installed: boolean): string[] {
  const copies = [installed
    ? "确认插件已启用，然后重新加载当前 Agent 会话。"
    : "点击下方安装，Pi 会校验插件并重新加载当前 Agent 会话。"];
  if (plugin.resources.some((resource) => resource === "extensions" || resource === "skills")) {
    copies.push("在对话中直接描述你的目标；Agent 会在适用时调用这个插件的能力。");
  }
  if (plugin.resources.includes("prompts")) {
    copies.push("打开可用命令，在插件提供的 Prompt 中选择适合当前任务的一项。");
  }
  if (plugin.resources.includes("themes")) {
    copies.push("重新加载后，在支持插件主题的 Pi 界面中选择新主题。");
  }
  copies.push("如果能力没有立即出现，请新建一个 Agent 会话后再试。");
  return copies;
}

const riskLabels = { low: "低风险", medium: "中风险", high: "高风险", blocked: "已阻止" } as const;
const scanStatusLabels = { clean: "内容扫描通过", review: "内容扫描需要审核", blocked: "内容扫描已阻止" } as const;
const securitySeverityLabels = { critical: "严重", high: "高", medium: "中", low: "低" } as const;
const securityCategoryLabels = {
  secrets: "凭据",
  "hidden-content": "隐藏内容",
  "prompt-injection": "Prompt 注入",
  permissions: "权限",
  execution: "本地执行",
  network: "网络",
  mcp: "MCP",
  coverage: "扫描覆盖",
} as const;

function PackageCapabilityCard({
  title,
  description,
  value,
  effective,
  installed,
  history,
  busy,
  onChange,
  onSave,
}: {
  title: string;
  description: string;
  value: string;
  effective: PackageCapabilityProvider | { kind: "pending" } | undefined;
  installed: InstalledPlugin[];
  history: PackageCapabilityProvider[];
  busy: boolean;
  onChange: (source: string) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const sources = [...new Set([
    ...installed.filter((plugin) => plugin.enabled && plugin.projectEnabled !== false && plugin.verification !== "tampered").map((plugin) => plugin.source),
    ...history.flatMap((provider) => provider.kind === "plugin" ? [provider.source] : []),
  ])];
  return (
    <section className={`${capabilityCardClass} min-w-0`}>
      <header className={capabilityCardHeaderClass}><span className="min-w-0"><strong className={capabilityCardTitleClass}>{t(title)}</strong><small className={capabilityCardNoteClass}>{t(description)}</small></span><span className={`${capabilityStateClass(false)} max-w-[150px] truncate`}>{effective?.kind === "plugin" ? effective.source.replace(/^npm:/, "") : t(effective?.kind === "none" ? "未启用" : "等待会话")}</span></header>
      <label className={capabilityToolFieldClass}><span className={capabilityToolLabelClass}>{t("能力提供者")}</span><span className="relative block"><select className={nativeSelectClass} value={value} onChange={(event) => onChange(event.target.value)}><option value="">{t("不启用")}</option>{sources.map((source) => <option value={source} key={source}>{source.replace(/^npm:/, "")}</option>)}</select><ChevronDown size={14} className={nativeSelectChevronClass} /></span><small className={capabilityToolNoteClass}>{t("切换不会删除旧插件数据；旧版本仍保留在历史中。")}</small></label>
      <footer className={capabilityCardFooterClass}><span className="text-caption text-label-3">{history.filter((provider) => provider.kind === "plugin").length} {t("个历史提供者")}</span><button className={primaryButtonClass} type="button" disabled={busy} onClick={onSave}>{t("应用能力提供者")}</button></footer>
    </section>
  );
}

export function PluginsPanel({ agentRunning, workspaceCwd }: PluginsPanelProps) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<"discover" | "installed">("discover");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [packages, setPackages] = useState<PluginPackage[]>([]);
  const [total, setTotal] = useState(0);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [runtime, setRuntime] = useState<PluginRuntimeStatus | null>(null);
  const [subagentKind, setSubagentKind] = useState<SubagentProvider["kind"]>("builtin");
  const [subagentSource, setSubagentSource] = useState("");
  const [subagentTool, setSubagentTool] = useState("");
  const [memorySource, setMemorySource] = useState("");
  const [learningSource, setLearningSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<PluginPackage | null>(null);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [progress, setProgress] = useState<PluginProgressEvent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const installedNames = useMemo(() => new Set(installed.map((plugin) => plugin.name)), [installed]);
  const subagentChoices = useMemo(() => {
    const choices = [
      ...(runtime?.tools.filter((tool) => tool.sourceKind === "package" || tool.sourceKind === "project").map((tool) => ({ source: tool.source, toolName: tool.name, description: tool.description })) ?? []),
      ...(runtime?.subagentHistory.flatMap((provider) => provider.kind === "plugin" ? [{ source: provider.source, toolName: provider.toolName, description: "历史提供者" }] : []) ?? []),
    ];
    const seen = new Set<string>();
    return choices.filter((choice) => {
      const key = `${choice.source}\0${choice.toolName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [runtime]);

  useEffect(() => {
    if (!window.piDesktop) {
      setError(t("插件中心只能在 Electron 应用中使用。"));
      return;
    }
    void Promise.all([
      window.piDesktop.plugins.list(workspaceCwd).then(setInstalled),
      window.piDesktop.plugins.runtime().then((status) => {
        receiveRuntime(status);
      }),
      searchPackages("", 0, false),
    ]).catch((caught: unknown) => setError(errorMessage(caught, t)));
    return window.piDesktop.plugins.onEvent(setProgress);
  }, [workspaceCwd]);

  function receiveRuntime(status: PluginRuntimeStatus) {
    setRuntime(status);
    setSubagentKind(status.configuredSubagent.kind);
    setSubagentSource(status.configuredSubagent.kind === "plugin" ? status.configuredSubagent.source : "");
    setSubagentTool(status.configuredSubagent.kind === "plugin" ? status.configuredSubagent.toolName : "");
    setMemorySource(status.configuredMemory.kind === "plugin" ? status.configuredMemory.source : "");
    setLearningSource(status.configuredLearning.kind === "plugin" ? status.configuredLearning.source : "");
  }

  async function searchPackages(searchQuery: string, offset = 0, append = false) {
    if (!window.piDesktop) {
      setError(t("插件中心只能在 Electron 应用中使用。"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.piDesktop.plugins.search(searchQuery, offset);
      setPackages((current) => append ? [...current, ...result.packages] : result.packages);
      setTotal(result.total);
      setSubmittedQuery(searchQuery);
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setLoading(false);
    }
  }

  async function openDetails(plugin: PluginPackage) {
    if (!window.piDesktop) return;
    setOperation(`details:${plugin.name}`);
    setError(null);
    try {
      const details = await window.piDesktop.plugins.details(plugin.name, plugin.version);
      setCandidate({
        ...plugin,
        ...details,
        weeklyDownloads: details.weeklyDownloads ?? plugin.weeklyDownloads,
        monthlyDownloads: details.monthlyDownloads ?? plugin.monthlyDownloads,
        score: details.score ?? plugin.score,
      });
      setRiskAccepted(false);
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setOperation(null);
    }
  }

  async function installCandidate() {
    if (!window.piDesktop || !candidate || !riskAccepted) return;
    setOperation(`install:${candidate.name}`);
    setError(null);
    setMessage(null);
    try {
      const result = await window.piDesktop.plugins.install(candidate.name, candidate.version);
      setInstalled(result.installed);
      receiveRuntime(result.runtime);
      setCandidate(null);
      setMessage(result.reloaded
        ? t("{name} 已安装，并已在当前会话中重新加载。", { name: candidate.name })
        : t("{name} 已安装，将在创建下一次 Agent 会话时启用。", { name: candidate.name }));
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setOperation(null);
      setProgress(null);
    }
  }

  async function removePlugin(plugin: InstalledPlugin) {
    if (!window.piDesktop) return;
    const confirmed = window.confirm(t("确定卸载 {name}？", { name: `${plugin.name}${plugin.version ? `@${plugin.version}` : ""}` }));
    if (!confirmed) return;
    setOperation(`remove:${plugin.source}`);
    setError(null);
    setMessage(null);
    try {
      const result = await window.piDesktop.plugins.remove(plugin.source);
      setInstalled(result.installed);
      receiveRuntime(result.runtime);
      setMessage(result.reloaded
        ? t("{name} 已卸载，当前会话已重新加载。", { name: plugin.name })
        : t("{name} 已卸载。", { name: plugin.name }));
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setOperation(null);
      setProgress(null);
    }
  }

  async function reloadPlugins() {
    if (!window.piDesktop) return;
    setOperation("reload");
    setError(null);
    setMessage(null);
    try {
      const result = await window.piDesktop.plugins.reload();
      receiveRuntime(result.runtime);
      setMessage(t(result.reloaded ? "当前 Agent 会话已重新加载插件。" : "目前没有活动会话；插件会在下次会话启动时加载。"));
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setOperation(null);
    }
  }

  async function setPluginEnabled(plugin: InstalledPlugin, enabled: boolean, scope: "user" | "project") {
    if (!window.piDesktop) return;
    setOperation(`enable:${plugin.source}:${scope}`);
    setError(null);
    setMessage(null);
    try {
      const result = await window.piDesktop.plugins.setEnabled(plugin.source, enabled, workspaceCwd, scope);
      setInstalled(result.installed);
      receiveRuntime(result.runtime);
      setMessage(t(enabled ? "{name} 已在{scope}启用{reload}。" : "{name} 已在{scope}停用{reload}。", {
        name: plugin.name,
        scope: t(scope === "project" ? "当前项目" : "所有项目"),
        reload: result.reloaded ? t("并重新加载") : "",
      }));
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setOperation(null);
    }
  }

  async function saveSubagentProvider() {
    if (!window.piDesktop) return;
    if (subagentKind === "plugin" && (!subagentSource || !subagentTool.trim())) {
      setError(t("请选择插件来源和由该 Extension 注册的工具名。"));
      return;
    }
    setOperation("capability");
    setError(null);
    setMessage(null);
    try {
      const provider: SubagentProvider = subagentKind === "builtin"
        ? { kind: "builtin" }
        : { kind: "plugin", source: subagentSource, toolName: subagentTool.trim() };
      const status = await window.piDesktop.plugins.setSubagentProvider(provider);
      receiveRuntime(status);
      setMessage(status.fallbackReason ?? (status.hasSession
        ? t(provider.kind === "builtin" ? "Subagent 已切换为内置实现。" : "Subagent 已切换为插件工具 {name}。", { name: provider.kind === "plugin" ? provider.toolName : "" })
        : t("已选择内置实现；第三方提供者需要在活动会话中验证。")));
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setOperation(null);
    }
  }

  async function savePackageCapability(slot: "memory" | "learning") {
    if (!window.piDesktop) return;
    const source = slot === "memory" ? memorySource : learningSource;
    setOperation(`capability:${slot}`);
    setError(null);
    setMessage(null);
    try {
      const provider: PackageCapabilityProvider = source ? { kind: "plugin", source } : { kind: "none" };
      const status = await window.piDesktop.plugins.setPackageCapability(slot, provider);
      receiveRuntime(status);
      setMessage(status.fallbackReason ?? t(slot === "memory" ? "记忆能力提供者已切换。" : "自学习能力提供者已切换。"));
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setOperation(null);
    }
  }

  return (
    <div className="w-full">
      <header className="mb-[27px] flex min-h-[62px] items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("插件中心")}</h2><p className="text-body text-label-2">{t("发现并管理 npm 上标记为 pi-package 的扩展、Skills、Prompts 与主题。")}</p></div>
        <button className={secondaryButtonClass} type="button" disabled={Boolean(operation) || agentRunning} onClick={() => void reloadPlugins()}><RefreshCw size={14} />{t("重新加载")}</button>
      </header>

      <div className="mb-5 flex gap-1 border-b border-separator" role="tablist" aria-label={t("插件分类")}>
        <button className={pluginTabClass(tab === "discover")} type="button" onClick={() => setTab("discover")}>{t("发现插件")}</button>
        <button className={pluginTabClass(tab === "installed")} type="button" onClick={() => setTab("installed")}>{t("已安装")} <span className="ml-1 rounded-full bg-fill px-1.5 py-0.5 font-mono text-mini text-label-2">{installed.length}</span></button>
      </div>

      {tab === "discover" ? (
        <>
          <form className="flex h-control-lg items-center gap-base rounded-sm border border-separator bg-fill pr-1 pl-[11px] text-label-3 transition-colors duration-150 ease-apple focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/32" onSubmit={(event) => { event.preventDefault(); void searchPackages(query.trim()); }}>
            <Search size={14} />
            <input className="min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-label outline-none placeholder:text-label-3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索 Pi 插件，例如 browser、git、memory")} aria-label={t("搜索插件")} />
            {query && <button className="grid size-7 flex-none cursor-pointer place-items-center rounded-sm text-label-3 transition-colors duration-150 ease-apple hover:bg-fill-2 hover:text-label" type="button" onClick={() => { setQuery(""); void searchPackages(""); }} aria-label={t("清空搜索")}><X size={14} /></button>}
            <button className="inline-flex h-control-sm flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-accent px-loose text-body font-semibold text-accent-ink transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="submit" disabled={loading}>{t(loading ? "搜索中…" : "搜索")}</button>
          </form>

          <div className="flex h-11 items-center justify-between text-caption text-label-2">
            <span>{submittedQuery ? t("“{query}” 的搜索结果", { query: submittedQuery }) : "Pi Packages"}</span>
            <small className="text-caption text-label-3">{total.toLocaleString(locale)} {t("个包")}</small>
          </div>

          <div className="grid grid-cols-1 items-stretch gap-loose">
            {packages.map((plugin) => {
              const isInstalled = installedNames.has(plugin.name);
              const isLoadingDetails = operation === `details:${plugin.name}`;
              return (
                <article className="flex min-h-[184px] min-w-0 flex-col rounded-md bg-bg-grouped p-card transition-colors duration-150 ease-apple hover:bg-bg-grouped-2" key={`${plugin.name}@${plugin.version}`}>
                  <button className="grid min-w-0 flex-1 cursor-pointer grid-rows-[auto_minmax(48px,1fr)_auto] content-start gap-loose text-left disabled:pointer-events-none disabled:opacity-40" type="button" disabled={Boolean(operation)} onClick={() => void openDetails(plugin)} aria-label={t("查看 {name} 的用途与使用方法", { name: plugin.name })}>
                    <header className={pluginCardHeaderClass}><span className={pluginIconClass}><Box size={18} /></span><span className="min-w-0"><strong className={pluginNameClass} title={plugin.name}>{plugin.name}</strong><small className={pluginSublineClass}>v{plugin.version} · {plugin.publisher}</small></span></header>
                    <p className="m-0 line-clamp-3 text-caption leading-[1.6] text-label-2">{plugin.description}</p>
                    <div className="flex flex-wrap items-center gap-[6px]">
                      {plugin.resources.length > 0 ? plugin.resources.map((resource) => <span className={`${badgeBaseClass} bg-fill text-label-2`} key={resource}>{t(resourceLabels[resource])}</span>) : <span className={`${badgeBaseClass} bg-fill text-label-2`}>Pi Package</span>}
                      <span className={`${badgeBaseClass} ${compatibilityBadgeClass[plugin.compatibility]}`}>{t(compatibilityCopy(plugin))}</span>
                      <span className={`${badgeBaseClass} ${riskBadgeClass[plugin.riskTier]}`}>{t(riskLabels[plugin.riskTier])}</span>
                    </div>
                  </button>
                  <footer className="mt-card flex min-h-control-lg items-center justify-between gap-[10px] border-t border-separator pt-loose">
                    <span className="truncate text-caption text-label-3">{compactNumber(plugin.weeklyDownloads, locale) ? `${compactNumber(plugin.weeklyDownloads, locale)} ${t("周下载")}` : plugin.license ?? t("许可证未知")}</span>
                    <button className={secondaryButtonClass} type="button" disabled={Boolean(operation)} onClick={() => void openDetails(plugin)}>
                      {isLoadingDetails ? t("读取中…") : <>{isInstalled ? <Check size={14} /> : <ChevronRight size={14} />}{t("查看用途")}</>}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>

          {!loading && packages.length === 0 && <div className={pluginEmptyClass}><Search size={18} /><strong className="text-body font-semibold text-label-2">{t("没有找到插件")}</strong><span className="text-caption">{t("换个关键词试试，或检查网络连接。")}</span></div>}
          {/* 居中用包裹层：secondaryButtonClass 的 inline-flex 在编译 CSS 中晚于 block/flex，
              同元素上加 mx-auto 无法生效。 */}
          {packages.length > 0 && packages.length < total && <div className="mt-card flex justify-center"><button className={secondaryButtonClass} type="button" disabled={loading} onClick={() => void searchPackages(submittedQuery, packages.length, true)}>{t(loading ? "加载中…" : "加载更多")}</button></div>}
        </>
      ) : (
        <>
          <section className={capabilityCardClass}>
            <header className={capabilityCardHeaderClass}><span className="min-w-0"><strong className={capabilityCardTitleClass}>{t("Subagent 能力提供者")}</strong><small className={capabilityCardNoteClass}>{t("可以保留 Pi Desktop 内置实现，或让第三方 Extension 工具接管。")}</small></span><span className={capabilityStateClass(Boolean(runtime?.fallbackReason))}>{runtime?.effectiveSubagent.kind === "plugin" ? runtime.effectiveSubagent.toolName : t(runtime?.effectiveSubagent.kind === "builtin" ? "内置" : "等待会话")}</span></header>
            <div className="mt-[15px] grid grid-cols-2 gap-base">
              <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-base rounded-md border border-separator bg-bg p-[11px] transition-colors duration-150 ease-apple has-[:checked]:border-accent/32 has-[:checked]:bg-accent/8"><input className="mt-0.5 accent-accent" type="radio" name="subagent-provider" checked={subagentKind === "builtin"} onChange={() => setSubagentKind("builtin")} /><span className="min-w-0"><strong className="block text-caption text-label">{t("内置实现")}</strong><small className="mt-1 block text-caption leading-[1.45] text-label-3">{t("使用 Pi Desktop 的只读子 Agent。")}</small></span></label>
              <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-base rounded-md border border-separator bg-bg p-[11px] transition-colors duration-150 ease-apple has-[:checked]:border-accent/32 has-[:checked]:bg-accent/8"><input className="mt-0.5 accent-accent" type="radio" name="subagent-provider" checked={subagentKind === "plugin"} onChange={() => setSubagentKind("plugin")} /><span className="min-w-0"><strong className="block text-caption text-label">{t("第三方工具")}</strong><small className="mt-1 block text-caption leading-[1.45] text-label-3">{t("使用已安装 Extension 注册的工具。")}</small></span></label>
            </div>
            {subagentKind === "plugin" && (
              <div className="mt-loose grid grid-cols-2 gap-[10px]">
                <label className="grid gap-[6px]"><span className={capabilityToolLabelClass}>{t("插件来源")}</span><span className="relative block"><select className={nativeSelectClass} value={subagentSource} onChange={(event) => { const source = event.target.value; setSubagentSource(source); setSubagentTool(subagentChoices.find((choice) => choice.source === source)?.toolName ?? ""); }}><option value="">{t("选择已加载或历史插件")}</option>{[...new Set(subagentChoices.map((choice) => choice.source))].map((source) => <option value={source} key={source}>{source.replace(/^npm:/, "")}</option>)}</select><ChevronDown size={14} className={nativeSelectChevronClass} /></span></label>
                <label className="grid gap-[6px]"><span className={capabilityToolLabelClass}>Extension {t("工具")}</span><span className="relative block"><select className={nativeSelectClass} value={subagentTool} onChange={(event) => setSubagentTool(event.target.value)}><option value="">{t("选择工具")}</option>{subagentChoices.filter((choice) => choice.source === subagentSource).map((choice) => <option value={choice.toolName} key={`${choice.source}:${choice.toolName}`}>{choice.toolName} — {choice.description}</option>)}</select><ChevronDown size={14} className={nativeSelectChevronClass} /></span></label>
                <small className="col-span-full text-caption text-label-3">{t("提供者由包来源、准确版本和工具名共同识别，同名工具不会再互相覆盖。")}</small>
              </div>
            )}
            {runtime?.fallbackReason && <div className="mt-[11px] flex items-center gap-[7px] rounded-sm bg-orange/8 px-[9px] py-2 text-caption text-orange"><AlertTriangle size={14} />{runtime.fallbackReason}</div>}
            <footer className={capabilityCardFooterClass}><span className="text-caption text-label-3">{runtime ? `${runtime.tools.filter((tool) => tool.active).length}/${runtime.tools.length} ${t("个工具已启用")}` : t("正在读取运行时…")}</span><button className={primaryButtonClass} type="button" disabled={Boolean(operation) || agentRunning} onClick={() => void saveSubagentProvider()}>{t(operation === "capability" ? "切换中…" : "应用能力提供者")}</button></footer>
          </section>

          <div className="grid grid-cols-2 gap-[10px]">
            <PackageCapabilityCard title="Memory 提供者" description="跨会话记忆与上下文注入；同一时间只运行一个。" value={memorySource} effective={runtime?.effectiveMemory} installed={installed} history={runtime?.memoryHistory ?? []} busy={Boolean(operation) || agentRunning} onChange={setMemorySource} onSave={() => void savePackageCapability("memory")} />
            <PackageCapabilityCard title="自学习提供者" description="观察会话并沉淀行为或技能；同一时间只运行一个。" value={learningSource} effective={runtime?.effectiveLearning} installed={installed} history={runtime?.learningHistory ?? []} busy={Boolean(operation) || agentRunning} onChange={setLearningSource} onSave={() => void savePackageCapability("learning")} />
          </div>

          {runtime?.hasSession && runtime.tools.some((tool) => tool.sourceKind === "package" || tool.sourceKind === "project") && (
            <section className={capabilityCardClass}><header className={`${capabilityCardHeaderClass} border-b border-separator pb-[11px]`}><span className="min-w-0"><strong className={capabilityCardTitleClass}>{t("已加载的插件工具")}</strong><small className={capabilityCardNoteClass}>{t("Reload 后从当前 Agent 工具注册表读取")}</small></span></header><div className="flex flex-wrap gap-[6px] pt-[11px]">{runtime.tools.filter((tool) => tool.sourceKind === "package" || tool.sourceKind === "project").map((tool) => <span className={tool.active ? "inline-flex items-center gap-[7px] rounded-sm border border-green/32 bg-bg px-2 py-1.5" : "inline-flex items-center gap-[7px] rounded-sm border border-separator bg-bg px-2 py-1.5"} key={`${tool.source}:${tool.name}`}><code className={tool.active ? "font-mono text-caption text-accent" : "font-mono text-caption text-label-2"}>{tool.name}</code><small className="text-caption text-label-3">{t(tool.active ? "已启用" : "未启用")}</small></span>)}</div></section>
          )}

          <div className="grid gap-base">
            {installed.map((plugin) => (
              <article className="grid min-w-0 grid-cols-[34px_minmax(0,1fr)_auto_auto] items-center gap-[11px] rounded-md bg-bg-grouped p-[13px]" key={plugin.source}>
                <span className={pluginIconClass}><PackageCheck size={18} /></span>
                <span className="min-w-0">
                  <strong className="block truncate font-mono text-body font-semibold text-label">{plugin.name}</strong>
                  <small className={pluginSublineClass}>{plugin.version ? `v${plugin.version}` : plugin.source} · {t(plugin.verification === "verified" ? "完整性已验证" : plugin.verification === "legacy" ? "旧安装，来源未验证" : plugin.verification === "tampered" ? "完整性异常" : "文件缺失")}</small>
                  <small className={pluginSublineClass}>{plugin.publisher ?? t("未知发布者")} · {plugin.provenance === "npm-registry" ? "npm registry" : t("旧版来源")} · {t(riskLabels[plugin.riskTier])}{plugin.integrity ? ` · ${plugin.integrity.slice(0, 22)}…` : ""}</small>
                  <small className={pluginSublineClass}>{plugin.securityScan
                    ? `${t(scanStatusLabels[plugin.securityScan.status])} · ${t("{files} 个文件，{findings} 项发现", { files: plugin.securityScan.scannedFiles, findings: plugin.securityScan.findings.length })}`
                    : t("未进行内容扫描")}</small>
                </span>
                <span className="flex gap-[6px]">
                  <button className={secondaryButtonClass} type="button" disabled={Boolean(operation) || agentRunning || plugin.verification === "tampered" || plugin.verification === "missing" || plugin.securityScan?.status === "blocked"} onClick={() => void setPluginEnabled(plugin, !plugin.enabled, "user")}>{plugin.enabled ? t("全局停用") : t("全局启用")}</button>
                  {workspaceCwd && <button className={secondaryButtonClass} type="button" disabled={Boolean(operation) || agentRunning || !plugin.enabled} onClick={() => void setPluginEnabled(plugin, plugin.projectEnabled === false, "project")}>{plugin.projectEnabled === false ? t("项目启用") : t("项目停用")}</button>}
                </span>
                <button className={`${secondaryButtonClass} text-red`} type="button" disabled={Boolean(operation) || agentRunning} onClick={() => void removePlugin(plugin)}><Trash2 size={14} />{t("卸载")}</button>
                {plugin.securityScan && plugin.securityScan.findings.length > 0 && (
                  <details className="col-span-full ml-[45px] rounded-sm border border-separator bg-bg px-[11px] py-[9px]">
                    <summary className="cursor-pointer text-caption font-semibold text-label-2">{t("安全扫描详情")}</summary>
                    <ul className="mt-[9px] grid list-none gap-[8px] p-0">
                      {plugin.securityScan.findings.slice(0, 12).map((finding) => (
                        <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-[8px] text-caption leading-[1.45]" key={`${finding.ruleId}:${finding.path}:${finding.line}`}>
                          <span className={finding.severity === "critical" || finding.severity === "high" ? "text-red" : finding.severity === "medium" ? "text-orange" : "text-label-3"}>{t(securitySeverityLabels[finding.severity])}</span>
                          <span className="min-w-0 text-label-2"><strong>{t(securityCategoryLabels[finding.category])} · {t(finding.message)}</strong><small className="mt-[2px] block wrap-anywhere font-mono text-label-3">{finding.path}:{finding.line} · {finding.ruleId}</small><small className="mt-[2px] block text-label-3">{t(finding.remediation)}</small></span>
                        </li>
                      ))}
                    </ul>
                    {plugin.securityScan.findings.length > 12 && <small className="mt-[9px] block text-caption text-label-3">{t("还有 {count} 项未显示", { count: plugin.securityScan.findings.length - 12 })}</small>}
                  </details>
                )}
              </article>
            ))}
            {installed.length === 0 && <div className={pluginEmptyClass}><PackageCheck size={18} /><strong className="text-body font-semibold text-label-2">{t("还没有安装插件")}</strong><span className="text-caption">{t("从“发现插件”中选择一个 Pi Package。")}</span></div>}
          </div>
        </>
      )}

      {agentRunning && <div className="mt-[13px] flex items-center gap-base rounded-sm bg-orange/8 px-loose py-[10px] text-caption text-orange"><AlertTriangle size={14} />{t("Agent 执行期间不能安装、卸载或重新加载插件。")}</div>}
      {progress && <div className="mt-[13px] flex items-center gap-base rounded-sm bg-bg-grouped px-loose py-[10px] text-caption text-label-2"><i className="activity-spinner" /><span>{progress.message ?? `${progress.action}: ${progress.source}`}</span></div>}
      {message && <div className="mt-[13px] flex items-center gap-base rounded-sm bg-green/8 px-loose py-[10px] text-caption text-green"><Check size={14} />{message}</div>}
      {error && <div className={pluginErrorClass} role="alert">{error}</div>}

      {candidate && (
        <div className="fixed inset-0 z-[500] grid place-items-center bg-black/60 p-6 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !operation) setCandidate(null); }}>
          <section className="relative max-h-[calc(100vh-48px)] w-full max-w-[620px] overflow-auto rounded-lg bg-bg-grouped p-6 shadow-3" role="dialog" aria-modal="true" aria-labelledby="plugin-dialog-title">
            <button className="absolute top-[13px] right-[13px] grid size-7 cursor-pointer place-items-center rounded-sm text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label disabled:pointer-events-none disabled:opacity-40" type="button" disabled={Boolean(operation)} onClick={() => setCandidate(null)} aria-label={t("关闭")}><X size={16} /></button>
            <header className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)] items-start gap-loose pr-8">
              <span className="grid size-10 place-items-center rounded-md bg-accent/16 text-accent"><Box size={18} /></span>
              <span className="min-w-0"><small className="mb-[5px] block text-caption font-semibold tracking-[0.06em] text-accent">{t("插件用途与使用方法")}</small><h3 className="m-0 wrap-anywhere text-title leading-[1.3] font-semibold tracking-[-0.02em] text-label" id="plugin-dialog-title">{candidate.name}</h3><p className="text-caption leading-[1.55] text-label-3">{t("版本")} {candidate.version} · {t("发布者")} {candidate.publisher}</p></span>
            </header>
            <div className="mt-[15px] mr-0 mb-[14px] ml-[52px] flex flex-wrap gap-[6px]">
              <span className={`${badgeBaseClass} ${riskBadgeClass[candidate.riskTier]}`}>{t(riskLabels[candidate.riskTier])}</span>
              <span className={`${badgeBaseClass} ${compatibilityBadgeClass[candidate.compatibility]}`}>{t(compatibilityCopy(candidate))}</span>
              {candidate.resources.map((resource) => <span className={`${badgeBaseClass} bg-fill text-label-2`} key={resource}>{t(resourceLabels[resource])}</span>)}
            </div>
            <div className="mt-[-5px] mr-0 mb-[14px] ml-[52px] flex flex-wrap gap-[6px] font-mono text-caption text-label-3 tabular-nums" aria-label={t("插件概况")}>
              <span>{candidate.weeklyDownloads !== undefined ? `${compactNumber(candidate.weeklyDownloads, locale)} ${t("周下载")}` : t("下载量未知")}</span>
              <span className="text-label-4" aria-hidden="true">·</span>
              <span>{candidate.license ?? t("许可证未知")}</span>
              <span className="text-label-4" aria-hidden="true">·</span>
              <span>{candidate.updatedAt ? t("更新于 {date}", { date: new Date(candidate.updatedAt).toLocaleDateString(locale) }) : t("更新时间未知")}</span>
            </div>

            <section className={pluginPurposeSectionClass}>
              <header className={pluginSectionHeaderClass}><strong className={pluginSectionTitleClass}>{t("你可以用它来")}</strong><small className={pluginSectionNoteClass}>{t("根据插件声明的能力整理")}</small></header>
              <p className="m-0 mb-loose max-w-[65ch] text-caption leading-[1.6] text-pretty text-label-2">{candidate.description}</p>
              <ul className={pluginStepListClass}>{capabilityCopies(candidate).map((copy) => <li className={pluginStepItemClass} key={copy}><Check size={14} className="mt-0.5 ml-[3px] text-green" /><span>{t(copy)}</span></li>)}</ul>
            </section>

            <section className={`${pluginPurposeSectionClass} mt-[10px]`}>
              <header className={pluginSectionHeaderClass}><strong className={pluginSectionTitleClass}>{t("怎么使用")}</strong><small className={pluginSectionNoteClass}>{t(installedNames.has(candidate.name) ? "已安装插件的使用步骤" : "安装后的使用步骤")}</small></header>
              <ol className={pluginStepListClass}>{usageCopies(candidate, installedNames.has(candidate.name)).map((copy, index) => <li className={pluginStepItemClass} key={copy}><em className="grid size-5 place-items-center rounded-sm bg-accent/16 font-mono text-caption not-italic text-accent">{index + 1}</em><span>{t(copy)}</span></li>)}</ol>
              {candidate.usage && <div className="mt-[14px] border-t border-separator pt-[13px]"><strong className="block text-caption font-semibold text-label">{t("作者提供的使用说明")}</strong><small className="mt-[3px] block text-caption text-label-3">{t("以下内容保留发布者原文")}</small><pre className="mt-[10px] max-h-[220px] overflow-auto rounded-sm border border-separator bg-bg-grouped p-[11px] font-mono text-caption leading-[1.6] break-words whitespace-pre-wrap text-label-2">{candidate.usage}</pre></div>}
            </section>

            <div className="mt-card grid grid-cols-[auto_minmax(0,1fr)] gap-[9px] rounded-md border border-orange/32 bg-orange/8 p-loose text-orange">
              <AlertTriangle size={16} />
              <span className="min-w-0"><strong className="block text-body font-semibold">{t("该包可以执行本地代码")}</strong><small className="mt-[5px] block text-caption leading-[1.5] text-label-2">{t("安装流程会禁用 npm scripts，但 Pi Extension 启用后仍以你的本地用户权限运行。请只安装你信任的发布者提供的包。")}</small></span>
            </div>
            {candidate.insecure && <div className="mt-[9px] rounded-sm bg-red/8 p-[9px] text-caption text-red">{t("npm 将这个版本标记为存在安全风险，不建议安装。")}</div>}
            {!installedNames.has(candidate.name) && <label className="mt-[15px] grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-[9px] text-caption leading-[1.5] text-label-2"><input className="mt-px accent-accent" type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /><span>{t("我信任此发布者，并了解插件拥有本地代码执行权限。")}</span></label>}
            <footer className="mt-5 flex justify-end gap-base"><button className={secondaryButtonClass} type="button" disabled={Boolean(operation)} onClick={() => setCandidate(null)}>{t("关闭")}</button><button className={primaryButtonClass} type="button" disabled={installedNames.has(candidate.name) || !riskAccepted || Boolean(operation) || candidate.insecure} onClick={() => void installCandidate()}>{t(installedNames.has(candidate.name) ? "已安装" : operation?.startsWith("install:") ? "安装并加载中…" : "安装并重新加载")}</button></footer>
          </section>
        </div>
      )}
    </div>
  );
}
