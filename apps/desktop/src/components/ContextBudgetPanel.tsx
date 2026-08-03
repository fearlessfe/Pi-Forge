import { Clock3, Gauge, Layers3, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  ContextBudgetCategory,
  ContextBudgetItem,
  ContextBudgetReport,
} from "../contracts";
import { useI18n } from "../i18n";

type ContextBudgetPanelProps = {
  cwd?: string;
  workspaceContextEnabled: boolean;
  projectTrusted: boolean;
};

const categoryLabels: Record<ContextBudgetCategory, string> = {
  systemPrompt: "系统提示词",
  agents: "AGENTS.md",
  skills: "Skills",
  prompts: "Prompts",
  extensions: "Extensions",
  mcpSchemas: "MCP schemas",
};

const loadModeLabels: Record<ContextBudgetItem["loadMode"], string> = {
  baseline: "基础上下文",
  "on-demand": "按需加载",
  mixed: "基础 + 按需",
};

const secondaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-base rounded-sm border border-separator bg-bg-grouped-2 px-card text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/32";

function tokens(value: number, locale: string): string {
  return `~${value.toLocaleString(locale)}`;
}

export function heaviestContextBudgetItems(report: ContextBudgetReport, limit = 8): ContextBudgetItem[] {
  return report.groups.flatMap((group) => group.items)
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function ContextBudgetReportView({ report }: { report: ContextBudgetReport }) {
  const { t, locale } = useI18n();
  const heaviest = heaviestContextBudgetItems(report);
  const summary = [
    { label: "总 Context Budget", value: report.totalEstimatedTokens, icon: Gauge },
    { label: "基础上下文", value: report.baselineEstimatedTokens, icon: Layers3 },
    { label: "按需加载", value: report.onDemandEstimatedTokens, icon: Clock3 },
    { label: "可禁用节省", value: report.estimatedSavingsTokens, icon: Zap },
  ];
  return (
    <>
      <section className="grid grid-cols-4 gap-loose max-[1180px]:grid-cols-2" aria-label={t("Context Budget 摘要")}>
        {summary.map(({ label, value, icon: Icon }) => (
          <article className="rounded-md border border-separator bg-bg-grouped p-card" key={label}>
            <span className="mb-loose inline-flex size-control-md items-center justify-center rounded-sm bg-accent/16 text-accent"><Icon size={16} /></span>
            <strong className="block font-mono text-title font-semibold text-label">{tokens(value, locale)}</strong>
            <small className="mt-tight block text-caption text-label-2">{t(label)} · tokens</small>
          </article>
        ))}
      </section>

      <section className="grid grid-cols-2 gap-loose max-[1120px]:grid-cols-1" aria-labelledby="context-budget-groups-title">
        <h3 className="col-span-full text-callout font-semibold text-label" id="context-budget-groups-title">{t("按类别")}</h3>
        {report.groups.map((group) => (
          <article className="rounded-md border border-separator bg-bg-grouped p-card" key={group.category}>
            <header className="flex items-start justify-between gap-card">
              <span className="min-w-0"><strong className="block text-body font-semibold text-label">{t(categoryLabels[group.category])}</strong><small className="mt-tight block text-caption text-label-3">{t("已启用 {enabled} / {total} 项", { enabled: group.enabledItems, total: group.totalItems })}</small></span>
              <strong className="font-mono text-callout text-label">{tokens(group.estimatedTokens, locale)}</strong>
            </header>
            <div className="mt-loose h-1.5 overflow-hidden rounded-full bg-fill-2" aria-hidden="true"><i className="block h-full rounded-full bg-accent" style={{ width: `${report.totalEstimatedTokens > 0 ? Math.max(3, group.estimatedTokens / report.totalEstimatedTokens * 100) : 0}%` }} /></div>
            <footer className="mt-base flex justify-between gap-base text-mini text-label-3"><span>{t("基础 {tokens}", { tokens: tokens(group.baselineEstimatedTokens, locale) })}</span><span>{t("按需 {tokens}", { tokens: tokens(group.onDemandEstimatedTokens, locale) })}</span></footer>
          </article>
        ))}
      </section>

      <section aria-labelledby="context-budget-heavy-title">
        <header className="mb-loose flex items-end justify-between gap-card"><span><h3 className="text-callout font-semibold text-label" id="context-budget-heavy-title">{t("最重资源")}</h3><p className="mt-tight text-caption text-label-3">{t("按资源的基础与按需成本之和排序。")}</p></span><small className="text-caption text-label-3">{t("可用资源总量 {tokens}", { tokens: tokens(report.availableEstimatedTokens, locale) })}</small></header>
        <ol className="grid list-none gap-base p-0">
          {heaviest.map((item) => (
            <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-card rounded-md border border-separator bg-bg-grouped px-card py-loose max-[1040px]:grid-cols-[minmax(0,1fr)_auto]" key={item.id}>
              <span className="min-w-0"><strong className="block truncate text-body font-semibold text-label">{item.name}</strong><small className="mt-tight block text-caption text-label-3">{t(categoryLabels[item.category])} · {t(loadModeLabels[item.loadMode])} · {t(item.scope === "project" ? "项目级" : item.scope === "user" ? "用户级" : item.scope === "runtime" ? "运行时" : "临时")}</small></span>
              <span className={item.enabled ? "rounded-full border border-green/32 bg-green/8 px-base py-base text-mini text-green" : "rounded-full border border-separator bg-fill px-base py-base text-mini text-label-3"}>{t(item.enabled ? "已启用" : "已停用")}</span>
              <span className="min-w-[132px] text-right max-[1040px]:col-span-2 max-[1040px]:min-w-0"><strong className="block font-mono text-body font-semibold text-label">{item.estimateStatus === "estimated" ? `${tokens(item.estimatedTokens, locale)} tokens` : t("暂无法估算")}</strong>{item.enabled && item.estimatedSavingsTokens > 0 && <small className="mt-tight block text-mini text-green">{t("禁用预计节省 {tokens}", { tokens: tokens(item.estimatedSavingsTokens, locale) })}</small>}{!item.enabled && item.estimatedTokens > 0 && <small className="mt-tight block text-mini text-label-3">{t("当前已排除 {tokens}", { tokens: tokens(item.estimatedTokens, locale) })}</small>}</span>
            </li>
          ))}
          {heaviest.length === 0 && <li className="rounded-md border border-dashed border-separator p-section text-center text-caption text-label-3">{t("当前没有可估算的上下文资源。")}</li>}
        </ol>
      </section>

      <aside className="rounded-md border border-blue/32 bg-blue/8 px-card py-loose text-caption leading-[1.55] text-label-2">
        <strong className="text-blue">{t("估算方法")}</strong> · {t("按 UTF-8 字节数 ÷ 4 向上取整；基础上下文随请求装配，Skills 正文与 Prompts 在调用时按需进入。Extension 与 MCP 只计算可确定的 tool schema，不读取或展示凭据与正文。")}
      </aside>
    </>
  );
}

export function ContextBudgetPanel({ cwd, workspaceContextEnabled, projectTrusted }: ContextBudgetPanelProps) {
  const { t } = useI18n();
  const [report, setReport] = useState<ContextBudgetReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!window.piDesktop?.resources?.contextBudget) return;
    setBusy(true);
    setError("");
    try {
      setReport(await window.piDesktop.resources.contextBudget(cwd ? { cwd } : undefined));
    } catch (caught) {
      setError((caught instanceof Error ? caught.message : String(caught)).replace(/^Error invoking remote method '[^']+': Error: /, ""));
    } finally {
      setBusy(false);
    }
  }, [cwd]);

  useEffect(() => { void refresh(); }, [refresh, workspaceContextEnabled, projectTrusted]);

  return (
    <div className="grid w-full max-w-[920px] content-start gap-card">
      <header className="flex min-h-[62px] items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("Context Budget")}</h2><p className="text-body text-label-2">{t("查看进入 Agent 上下文的资源成本、加载时机与可节省空间。")}</p></div>
        <button className={secondaryButtonClass} type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? "is-spinning" : ""} size={14} />{t(busy ? "估算中…" : "重新估算")}</button>
      </header>
      {!window.piDesktop?.resources?.contextBudget && <div className="rounded-sm border border-orange/32 bg-orange/8 px-loose py-loose text-caption text-orange" role="status">{t("Context Budget 仅在 Electron 应用中可用。")}</div>}
      {error && <div className="rounded-sm border border-red/32 bg-red/8 px-loose py-loose text-caption text-red" role="alert">{error}</div>}
      {!report && busy && <div className="grid min-h-[180px] place-items-center text-caption text-label-3" role="status"><span className="inline-flex items-center gap-base"><RefreshCw className="is-spinning" size={16} />{t("正在盘点上下文资源…")}</span></div>}
      {report && <ContextBudgetReportView report={report} />}
    </div>
  );
}
