import {
  AlertTriangle,
  Box,
  Check,
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
  PluginRuntimeStatus,
  SubagentProvider,
} from "../contracts";

type PluginsPanelProps = {
  agentRunning: boolean;
  workspaceCwd?: string;
};

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
    <section className="capability-card package-capability-card">
      <header><span><strong>{t(title)}</strong><small>{t(description)}</small></span><span className="capability-state">{effective?.kind === "plugin" ? effective.source.replace(/^npm:/, "") : t(effective?.kind === "none" ? "未启用" : "等待会话")}</span></header>
      <label className="capability-tool-field"><span>{t("能力提供者")}</span><select className="native-select" value={value} onChange={(event) => onChange(event.target.value)}><option value="">{t("不启用")}</option>{sources.map((source) => <option value={source} key={source}>{source.replace(/^npm:/, "")}</option>)}</select><small>{t("切换不会删除旧插件数据；旧版本仍保留在历史中。")}</small></label>
      <footer><span>{history.filter((provider) => provider.kind === "plugin").length} {t("个历史提供者")}</span><button className="primary-button" type="button" disabled={busy} onClick={onSave}>{t("应用能力提供者")}</button></footer>
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
    <div className="settings-panel plugins-panel">
      <header className="settings-page-header plugins-header">
        <div><h2>{t("插件")}</h2><p>{t("发现并管理 npm 上标记为 pi-package 的扩展、Skills、Prompts 与主题。")}</p></div>
        <button className="secondary-button plugin-reload-button" type="button" disabled={Boolean(operation) || agentRunning} onClick={() => void reloadPlugins()}><RefreshCw size={13} />{t("重新加载")}</button>
      </header>

      <div className="plugin-tabs" role="tablist" aria-label={t("插件分类")}>
        <button className={tab === "discover" ? "is-active" : ""} type="button" onClick={() => setTab("discover")}>{t("发现插件")}</button>
        <button className={tab === "installed" ? "is-active" : ""} type="button" onClick={() => setTab("installed")}>{t("已安装")} <span>{installed.length}</span></button>
      </div>

      {tab === "discover" ? (
        <>
          <form className="plugin-search" onSubmit={(event) => { event.preventDefault(); void searchPackages(query.trim()); }}>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索 Pi 插件，例如 browser、git、memory")} aria-label={t("搜索插件")} />
            {query && <button className="plugin-search-clear" type="button" onClick={() => { setQuery(""); void searchPackages(""); }} aria-label={t("清空搜索")}><X size={13} /></button>}
            <button className="primary-button" type="submit" disabled={loading}>{t(loading ? "搜索中…" : "搜索")}</button>
          </form>

          <div className="plugin-result-meta">
            <span>{submittedQuery ? t("“{query}” 的搜索结果", { query: submittedQuery }) : "Pi Packages"}</span>
            <small>{total.toLocaleString(locale)} {t("个包")}</small>
          </div>

          <div className="plugin-grid">
            {packages.map((plugin) => {
              const isInstalled = installedNames.has(plugin.name);
              const isLoadingDetails = operation === `details:${plugin.name}`;
              return (
                <article className="plugin-card" key={`${plugin.name}@${plugin.version}`}>
                  <button className="plugin-card-details-trigger" type="button" disabled={Boolean(operation)} onClick={() => void openDetails(plugin)} aria-label={t("查看 {name} 的用途与使用方法", { name: plugin.name })}>
                    <header><span className="plugin-icon"><Box size={18} /></span><span><strong title={plugin.name}>{plugin.name}</strong><small>v{plugin.version} · {plugin.publisher}</small></span><ChevronRight className="plugin-card-chevron" size={15} /></header>
                    <p>{plugin.description}</p>
                    <div className="plugin-tags">
                      {plugin.resources.length > 0 ? plugin.resources.map((resource) => <span key={resource}>{t(resourceLabels[resource])}</span>) : <span>Pi Package</span>}
                      <span className={`compatibility-badge compatibility-badge--${plugin.compatibility}`}>{t(compatibilityCopy(plugin))}</span>
                      <span className={`plugin-risk plugin-risk--${plugin.riskTier}`}>{t(riskLabels[plugin.riskTier])}</span>
                    </div>
                  </button>
                  <footer>
                    <span>{compactNumber(plugin.weeklyDownloads, locale) ? `${compactNumber(plugin.weeklyDownloads, locale)} ${t("周下载")}` : plugin.license ?? t("许可证未知")}</span>
                    <button className="secondary-button" type="button" disabled={Boolean(operation)} onClick={() => void openDetails(plugin)}>
                      {isLoadingDetails ? t("读取中…") : <>{isInstalled ? <Check size={13} /> : <ChevronRight size={13} />}{t("查看用途")}</>}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>

          {!loading && packages.length === 0 && <div className="plugin-empty"><Search size={20} /><strong>{t("没有找到插件")}</strong><span>{t("换个关键词试试，或检查网络连接。")}</span></div>}
          {packages.length > 0 && packages.length < total && <button className="plugin-load-more secondary-button" type="button" disabled={loading} onClick={() => void searchPackages(submittedQuery, packages.length, true)}>{t(loading ? "加载中…" : "加载更多")}</button>}
        </>
      ) : (
        <>
          <section className="capability-card">
            <header><span><strong>{t("Subagent 能力提供者")}</strong><small>{t("可以保留 Pi Desktop 内置实现，或让第三方 Extension 工具接管。")}</small></span><span className={`capability-state ${runtime?.fallbackReason ? "is-fallback" : ""}`}>{runtime?.effectiveSubagent.kind === "plugin" ? runtime.effectiveSubagent.toolName : t(runtime?.effectiveSubagent.kind === "builtin" ? "内置" : "等待会话")}</span></header>
            <div className="capability-options">
              <label><input type="radio" name="subagent-provider" checked={subagentKind === "builtin"} onChange={() => setSubagentKind("builtin")} /><span><strong>{t("内置实现")}</strong><small>{t("使用 Pi Desktop 的只读子 Agent。")}</small></span></label>
              <label><input type="radio" name="subagent-provider" checked={subagentKind === "plugin"} onChange={() => setSubagentKind("plugin")} /><span><strong>{t("第三方工具")}</strong><small>{t("使用已安装 Extension 注册的工具。")}</small></span></label>
            </div>
            {subagentKind === "plugin" && (
              <div className="capability-provider-fields">
                <label className="capability-tool-field"><span>{t("插件来源")}</span><select className="native-select" value={subagentSource} onChange={(event) => { const source = event.target.value; setSubagentSource(source); setSubagentTool(subagentChoices.find((choice) => choice.source === source)?.toolName ?? ""); }}><option value="">{t("选择已加载或历史插件")}</option>{[...new Set(subagentChoices.map((choice) => choice.source))].map((source) => <option value={source} key={source}>{source.replace(/^npm:/, "")}</option>)}</select></label>
                <label className="capability-tool-field"><span>Extension {t("工具")}</span><select className="native-select" value={subagentTool} onChange={(event) => setSubagentTool(event.target.value)}><option value="">{t("选择工具")}</option>{subagentChoices.filter((choice) => choice.source === subagentSource).map((choice) => <option value={choice.toolName} key={`${choice.source}:${choice.toolName}`}>{choice.toolName} — {choice.description}</option>)}</select></label>
                <small>{t("提供者由包来源、准确版本和工具名共同识别，同名工具不会再互相覆盖。")}</small>
              </div>
            )}
            {runtime?.fallbackReason && <div className="capability-fallback"><AlertTriangle size={13} />{runtime.fallbackReason}</div>}
            <footer><span>{runtime ? `${runtime.tools.filter((tool) => tool.active).length}/${runtime.tools.length} ${t("个工具已启用")}` : t("正在读取运行时…")}</span><button className="primary-button" type="button" disabled={Boolean(operation) || agentRunning} onClick={() => void saveSubagentProvider()}>{t(operation === "capability" ? "切换中…" : "应用能力提供者")}</button></footer>
          </section>

          <div className="package-capability-grid">
            <PackageCapabilityCard title="Memory 提供者" description="跨会话记忆与上下文注入；同一时间只运行一个。" value={memorySource} effective={runtime?.effectiveMemory} installed={installed} history={runtime?.memoryHistory ?? []} busy={Boolean(operation) || agentRunning} onChange={setMemorySource} onSave={() => void savePackageCapability("memory")} />
            <PackageCapabilityCard title="自学习提供者" description="观察会话并沉淀行为或技能；同一时间只运行一个。" value={learningSource} effective={runtime?.effectiveLearning} installed={installed} history={runtime?.learningHistory ?? []} busy={Boolean(operation) || agentRunning} onChange={setLearningSource} onSave={() => void savePackageCapability("learning")} />
          </div>

          {runtime?.hasSession && runtime.tools.some((tool) => tool.sourceKind === "package" || tool.sourceKind === "project") && (
            <section className="runtime-tools-card"><header><strong>{t("已加载的插件工具")}</strong><small>{t("Reload 后从当前 Agent 工具注册表读取")}</small></header><div>{runtime.tools.filter((tool) => tool.sourceKind === "package" || tool.sourceKind === "project").map((tool) => <span className={tool.active ? "is-active" : ""} key={`${tool.source}:${tool.name}`}><code>{tool.name}</code><small>{t(tool.active ? "已启用" : "未启用")}</small></span>)}</div></section>
          )}

          <div className="installed-plugin-list">
            {installed.map((plugin) => (
              <article className="installed-plugin" key={plugin.source}>
                <span className="plugin-icon"><PackageCheck size={18} /></span>
                <span className="installed-plugin-details">
                  <strong>{plugin.name}</strong>
                  <small>{plugin.version ? `v${plugin.version}` : plugin.source} · {t(plugin.verification === "verified" ? "完整性已验证" : plugin.verification === "legacy" ? "旧安装，来源未验证" : plugin.verification === "tampered" ? "完整性异常" : "文件缺失")}</small>
                  <small>{plugin.publisher ?? t("未知发布者")} · {plugin.provenance === "npm-registry" ? "npm registry" : t("旧版来源")} · {t(riskLabels[plugin.riskTier])}{plugin.integrity ? ` · ${plugin.integrity.slice(0, 22)}…` : ""}</small>
                </span>
                <span className="plugin-enable-actions">
                  <button className="secondary-button" type="button" disabled={Boolean(operation) || agentRunning || plugin.verification === "tampered" || plugin.verification === "missing"} onClick={() => void setPluginEnabled(plugin, !plugin.enabled, "user")}>{plugin.enabled ? t("全局停用") : t("全局启用")}</button>
                  {workspaceCwd && <button className="secondary-button" type="button" disabled={Boolean(operation) || agentRunning || !plugin.enabled} onClick={() => void setPluginEnabled(plugin, plugin.projectEnabled === false, "project")}>{plugin.projectEnabled === false ? t("项目启用") : t("项目停用")}</button>}
                </span>
                <button className="secondary-button danger-button" type="button" disabled={Boolean(operation) || agentRunning} onClick={() => void removePlugin(plugin)}><Trash2 size={13} />{t("卸载")}</button>
              </article>
            ))}
            {installed.length === 0 && <div className="plugin-empty"><PackageCheck size={20} /><strong>{t("还没有安装插件")}</strong><span>{t("从“发现插件”中选择一个 Pi Package。")}</span></div>}
          </div>
        </>
      )}

      {agentRunning && <div className="plugin-warning"><AlertTriangle size={14} />{t("Agent 执行期间不能安装、卸载或重新加载插件。")}</div>}
      {progress && <div className="plugin-progress"><i /><span>{progress.message ?? `${progress.action}: ${progress.source}`}</span></div>}
      {message && <div className="plugin-message"><Check size={14} />{message}</div>}
      {error && <div className="settings-error" role="alert">{error}</div>}

      {candidate && (
        <div className="plugin-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !operation) setCandidate(null); }}>
          <section className="plugin-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-dialog-title">
            <button className="plugin-dialog-close" type="button" disabled={Boolean(operation)} onClick={() => setCandidate(null)} aria-label={t("关闭")}><X size={15} /></button>
            <header className="plugin-dialog-heading">
              <span className="plugin-dialog-icon"><Box size={20} /></span>
              <span><small>{t("插件用途与使用方法")}</small><h3 id="plugin-dialog-title">{candidate.name}</h3><p className="plugin-dialog-version">{t("版本")} {candidate.version} · {t("发布者")} {candidate.publisher}</p></span>
            </header>
            <div className="plugin-detail-badges">
              <span className={`plugin-risk plugin-risk--${candidate.riskTier}`}>{t(riskLabels[candidate.riskTier])}</span>
              <span>{t(compatibilityCopy(candidate))}</span>
              {candidate.resources.map((resource) => <span key={resource}>{t(resourceLabels[resource])}</span>)}
            </div>
            <div className="plugin-compact-meta" aria-label={t("插件概况")}>
              <span>{candidate.weeklyDownloads !== undefined ? `${compactNumber(candidate.weeklyDownloads, locale)} ${t("周下载")}` : t("下载量未知")}</span>
              <span>{candidate.license ?? t("许可证未知")}</span>
              <span>{candidate.updatedAt ? t("更新于 {date}", { date: new Date(candidate.updatedAt).toLocaleDateString(locale) }) : t("更新时间未知")}</span>
            </div>

            <section className="plugin-purpose-section">
              <header><strong>{t("你可以用它来")}</strong><small>{t("根据插件声明的能力整理")}</small></header>
              <p>{candidate.description}</p>
              <ul>{capabilityCopies(candidate).map((copy) => <li key={copy}><Check size={13} /><span>{t(copy)}</span></li>)}</ul>
            </section>

            <section className="plugin-usage-section">
              <header><strong>{t("怎么使用")}</strong><small>{t(installedNames.has(candidate.name) ? "已安装插件的使用步骤" : "安装后的使用步骤")}</small></header>
              <ol>{usageCopies(candidate, installedNames.has(candidate.name)).map((copy, index) => <li key={copy}><em>{index + 1}</em><span>{t(copy)}</span></li>)}</ol>
              {candidate.usage && <div className="plugin-publisher-usage"><strong>{t("作者提供的使用说明")}</strong><small>{t("以下内容保留发布者原文")}</small><pre>{candidate.usage}</pre></div>}
            </section>

            <div className="plugin-security-warning">
              <AlertTriangle size={17} />
              <span><strong>{t("该包可以执行本地代码")}</strong><small>{t("npm 安装脚本和 Pi Extension 将以你的本地用户权限运行。请只安装你信任的发布者提供的包。")}</small></span>
            </div>
            {candidate.insecure && <div className="plugin-insecure-warning">{t("npm 将这个版本标记为存在安全风险，不建议安装。")}</div>}
            {!installedNames.has(candidate.name) && <label className="plugin-risk-check"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /><span>{t("我信任此发布者，并了解插件拥有本地代码执行权限。")}</span></label>}
            <footer><button className="secondary-button" type="button" disabled={Boolean(operation)} onClick={() => setCandidate(null)}>{t("关闭")}</button><button className="primary-button" type="button" disabled={installedNames.has(candidate.name) || !riskAccepted || Boolean(operation) || candidate.insecure} onClick={() => void installCandidate()}>{t(installedNames.has(candidate.name) ? "已安装" : operation?.startsWith("install:") ? "安装并加载中…" : "安装并重新加载")}</button></footer>
          </section>
        </div>
      )}
    </div>
  );
}
