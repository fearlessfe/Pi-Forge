import { Activity, ChevronDown, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ObservabilitySettings,
  SaveObservabilitySettings,
  SaveOtlpTraceExporterSettings,
  TraceRuntimeStatus,
} from "../contracts";
import { useI18n } from "../i18n";

type ExporterForm = SaveOtlpTraceExporterSettings & { headerText: string; hasSavedHeaders: boolean };
type TraceForm = Omit<SaveObservabilitySettings, "exporters"> & { exporters: ExporterForm[] };

function toForm(settings: ObservabilitySettings): TraceForm {
  return {
    enabled: settings.enabled,
    serviceName: settings.serviceName,
    captureContent: settings.captureContent,
    localFileEnabled: settings.localFileEnabled,
    exporters: settings.exporters.map((exporter) => ({
      id: exporter.id,
      name: exporter.name,
      endpoint: exporter.endpoint,
      enabled: exporter.enabled,
      hasSavedHeaders: exporter.hasHeaders,
      headerText: "",
    })),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error);
}

/* Trace 面板工具类组合（token v2，docs/design-refresh-apple.md 3.2/3.5）：
   与 D3-1 SettingsView / D4 McpPanel 同一语言 —— 按钮 text-body/600 + control 档；
   表单控件 bg-fill + border-separator + rounded-sm + focus-visible:ring-2 ring-accent/32。 */
const primaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-base rounded-sm border-0 bg-accent px-card text-body font-semibold text-accent-ink transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const secondaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-base rounded-sm border border-separator bg-bg-grouped-2 px-card text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const formInputClass =
  "h-control-lg w-full rounded-sm border border-separator bg-fill px-loose font-mono text-caption text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40";
const formTextareaClass =
  "min-h-[64px] w-full resize-y rounded-sm border border-separator bg-fill px-loose py-base font-mono text-caption text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40";
const inlineInputClass =
  "h-control-md w-[260px] flex-none rounded-sm border border-separator bg-fill px-loose font-mono text-caption text-label outline-none focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40";
const inlineSelectClass =
  "h-control-md w-[260px] flex-none cursor-pointer appearance-none rounded-sm border border-separator bg-fill pr-8 pl-loose text-body text-label outline-none focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40";
const nativeSelectChevronClass = "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-label-3";
const fieldLabelClass = "grid gap-base text-caption font-semibold text-label-2";
const settingsErrorClass = "mt-loose rounded-sm border border-red/32 bg-red/8 px-loose py-loose text-caption text-red";
const settingsSuccessClass = "mt-3 rounded-sm border border-green/32 bg-green/8 px-loose py-base text-caption text-green";
const switchClass = (on: boolean) =>
  on
    ? "relative h-5 w-9 flex-none cursor-pointer rounded-full bg-accent p-0.5 transition-colors duration-150 ease-apple before:absolute before:-inset-1 before:content-[''] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
    : "relative h-5 w-9 flex-none cursor-pointer rounded-full bg-fill-2 p-0.5 transition-colors duration-150 ease-apple before:absolute before:-inset-1 before:content-[''] hover:bg-fill-3 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const switchKnobClass = (on: boolean) =>
  on
    ? "block size-4 translate-x-4 rounded-full border border-separator bg-knob shadow-1 transition-transform duration-150 ease-apple"
    : "block size-4 rounded-full border border-separator bg-knob shadow-1 transition-transform duration-150 ease-apple";
const toggleRowClass = "flex min-h-[64px] items-center justify-between gap-6 border-b border-separator px-card last:border-b-0";
const toggleRowTextClass = "grid min-w-0 gap-tight";
const toggleRowTitleClass = "text-body font-semibold text-label";
const toggleRowNoteClass = "text-caption text-label-3";
/* 运行状态圆点：语义色静态映射（3.5 规则 2），error→red、ready→green、停用→label-4。 */
const statusDotClass = (status: TraceRuntimeStatus) =>
  status.lastError
    ? "size-[7px] flex-none rounded-full bg-red ring-4 ring-red/8"
    : status.enabled
      ? "size-[7px] flex-none rounded-full bg-green ring-4 ring-green/8"
      : "size-[7px] flex-none rounded-full bg-label-4";

export function ObservabilityPanel({ agentRunning }: { agentRunning: boolean }) {
  const { t } = useI18n();
  const [form, setForm] = useState<TraceForm>();
  const [status, setStatus] = useState<TraceRuntimeStatus>();
  const [busy, setBusy] = useState<"save" | "flush" | "refresh" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function load() {
    if (!window.piDesktop?.observability) throw new Error(t("Trace 模块尚未加载，请重新启动应用。"));
    const [settings, runtime] = await Promise.all([
      window.piDesktop.observability.get(),
      window.piDesktop.observability.status(),
    ]);
    setForm(toForm(settings));
    setStatus(runtime);
  }

  useEffect(() => {
    setBusy("refresh");
    void load().catch((caught) => setError(message(caught))).finally(() => setBusy(null));
  }, []);

  function updateExporter(index: number, patch: Partial<ExporterForm>) {
    setForm((current) => current ? {
      ...current,
      exporters: current.exporters.map((exporter, exporterIndex) => exporterIndex === index ? { ...exporter, ...patch } : exporter),
    } : current);
    setSaved(false);
  }

  function addExporter() {
    setForm((current) => current ? {
      ...current,
      exporters: [...current.exporters, {
        name: "OTLP",
        endpoint: "http://127.0.0.1:4318",
        enabled: true,
        headerText: "",
        hasSavedHeaders: false,
      }],
    } : current);
    setSaved(false);
  }

  async function save() {
    if (!form || !window.piDesktop?.observability) return;
    setBusy("save");
    setError("");
    setSaved(false);
    try {
      const exporters = form.exporters.map(({ headerText, hasSavedHeaders: _hasSavedHeaders, ...exporter }) => {
        let headers: Record<string, string> | undefined;
        if (headerText.trim()) {
          const parsed = JSON.parse(headerText) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
            throw new Error(t("请求头必须是仅包含字符串值的 JSON 对象。"));
          }
          headers = parsed as Record<string, string>;
        }
        return { ...exporter, headers };
      });
      const settings = await window.piDesktop.observability.save({
        enabled: form.enabled,
        serviceName: form.serviceName,
        captureContent: form.captureContent,
        localFileEnabled: form.localFileEnabled,
        exporters,
      });
      setForm(toForm(settings));
      setStatus(await window.piDesktop.observability.status());
      setSaved(true);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  async function flush() {
    if (!window.piDesktop?.observability) return;
    setBusy("flush");
    setError("");
    try {
      setStatus(await window.piDesktop.observability.flush());
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  if (!form) {
    return <div className="grid w-full max-w-[760px] content-start gap-3"><div className="flex items-center gap-base p-card text-caption text-label-3"><RefreshCw size={16} />{t(busy ? "正在读取 Trace 设置…" : "无法读取 Trace 设置")}</div>{error && <div className={settingsErrorClass}>{error}</div>}</div>;
  }

  return (
    <div className="grid w-full max-w-[760px] content-start gap-3">
      <header className="mb-card flex min-h-[62px] items-start justify-between gap-5"><div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("Trace")}</h2><p className="text-body text-label-2">{t("记录 Agent、模型与工具调用，并导出到任何兼容 OTLP 的可观测平台。")}</p></div></header>

      <section className="rounded-md border border-separator bg-bg-grouped">
        <label className={toggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("启用 Agent Trace")}</strong><small className={toggleRowNoteClass}>{t("Trace 故障不会中断 Agent 执行。")}</small></span><button className={switchClass(form.enabled)} type="button" aria-pressed={form.enabled} onClick={() => { setForm({ ...form, enabled: !form.enabled }); setSaved(false); }}><i className={switchKnobClass(form.enabled)} /></button></label>
        <label className={toggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("本地 Trace 文件")}</strong><small className={toggleRowNoteClass}>{status?.localTracePath ?? t("按日期写入受保护的 JSONL 文件")}</small></span><button className={switchClass(form.localFileEnabled)} type="button" aria-pressed={form.localFileEnabled} onClick={() => { setForm({ ...form, localFileEnabled: !form.localFileEnabled }); setSaved(false); }}><i className={switchKnobClass(form.localFileEnabled)} /></button></label>
        <label className={toggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("Service Name")}</strong><small className={toggleRowNoteClass}>{t("在 Trace 平台中标识这个应用实例")}</small></span><input className={inlineInputClass} value={form.serviceName} maxLength={128} onChange={(event) => { setForm({ ...form, serviceName: event.target.value }); setSaved(false); }} /></label>
        <label className={toggleRowClass}><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("内容采集")}</strong><small className={toggleRowNoteClass}>{t("控制 Prompt、输出和工具参数的采集范围")}</small></span><span className="relative block flex-none"><select className={inlineSelectClass} value={form.captureContent} onChange={(event) => { setForm({ ...form, captureContent: event.target.value as TraceForm["captureContent"] }); setSaved(false); }}><option value="none">{t("不采集内容")}</option><option value="metadata">{t("仅长度与哈希")}</option><option value="full">{t("完整内容")}</option></select><ChevronDown size={14} className={nativeSelectChevronClass} /></span></label>
      </section>

      <section className="mt-base rounded-md border border-separator bg-bg-grouped p-card">
        <header className="flex items-center justify-between gap-card"><span className={toggleRowTextClass}><strong className={toggleRowTitleClass}>{t("OTLP Exporters")}</strong><small className={toggleRowNoteClass}>{t("一个 Span 可同时发送到 Langfuse、Tempo、Jaeger、Datadog 等平台。")}</small></span><button className={secondaryButtonClass} type="button" onClick={addExporter}><Plus size={14} />{t("添加 Endpoint")}</button></header>
        {form.exporters.map((exporter, index) => (
          <article className="mt-loose grid gap-3 rounded-md border border-separator bg-bg-grouped-2 p-card" key={exporter.id ?? `new-${index}`}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-base"><button className={switchClass(exporter.enabled)} type="button" aria-label={t("启用 Exporter")} aria-pressed={exporter.enabled} onClick={() => updateExporter(index, { enabled: !exporter.enabled })}><i className={switchKnobClass(exporter.enabled)} /></button><input className="h-control-md w-full rounded-sm border-0 bg-transparent px-base text-body font-semibold text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32" value={exporter.name} aria-label={t("Exporter 名称")} placeholder="Langfuse" onChange={(event) => updateExporter(index, { name: event.target.value })} /><button className="grid size-control-md cursor-pointer place-items-center rounded-sm border-0 bg-transparent text-label-3 transition-colors duration-150 ease-apple hover:bg-red/8 hover:text-red active:scale-[0.98]" type="button" aria-label={t("删除 Exporter")} onClick={() => { setForm({ ...form, exporters: form.exporters.filter((_, candidateIndex) => candidateIndex !== index) }); setSaved(false); }}><Trash2 size={14} /></button></div>
            <label className={fieldLabelClass}><span>OTLP HTTP Endpoint</span><input className={formInputClass} value={exporter.endpoint} spellCheck={false} placeholder="https://host.example/api/public/otel" onChange={(event) => updateExporter(index, { endpoint: event.target.value })} /></label>
            <label className={fieldLabelClass}><span>{t("请求头 JSON")}</span><textarea className={formTextareaClass} value={exporter.headerText} spellCheck={false} placeholder={exporter.hasSavedHeaders ? t("留空以保留已加密保存的请求头") : '{"Authorization":"Basic …"}'} onChange={(event) => updateExporter(index, { headerText: event.target.value })} /></label>
            {exporter.hasSavedHeaders && !exporter.headerText && <small className="text-caption text-green">{t("请求头已使用操作系统安全存储加密")}</small>}
          </article>
        ))}
        {form.exporters.length === 0 && <div className="mt-loose flex min-h-[120px] flex-col items-center justify-center gap-base rounded-md border border-dashed border-separator text-center text-caption text-label-3"><Activity size={18} /><strong className="text-label-2">{t("尚未配置远程 Exporter")}</strong><small className="max-w-[440px] leading-[1.5]">{t("本地 Trace 仍会正常记录；添加任意 OTLP HTTP Endpoint 即可远程导出。")}</small></div>}
      </section>

      {status && <section className="mt-base grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-tight rounded-md border border-separator bg-bg-grouped px-loose py-loose"><span className="flex items-center gap-base text-caption text-label"><i className={statusDotClass(status)} /><strong className="font-semibold">{t(status.enabled ? "Trace 运行中" : "Trace 已停用")}</strong></span><small className="justify-self-end text-caption text-label-3">{t("待发送 Span：{count}", { count: status.queuedSpanCount })}{status.lastExportAt ? ` · ${t("最后导出：{time}", { time: new Date(status.lastExportAt).toLocaleTimeString() })}` : ""}</small>{status.lastError && <em className="col-span-full font-mono text-caption not-italic leading-[1.5] text-red">{status.lastError}</em>}</section>}
      {error && <div className={settingsErrorClass} role="alert">{error}</div>}
      {saved && <div className={settingsSuccessClass}>{t("Trace 设置已保存。")}</div>}
      <footer className="mt-base flex items-end justify-between gap-card border-t border-separator pt-card"><small className="max-w-[440px] text-caption leading-[1.5] text-label-3">{t(agentRunning ? "Agent 正在运行，任务结束后才能修改 Trace 设置。" : "Endpoint 会自动补全 /v1/traces；请求头只保存在操作系统安全存储中。")}</small><div className="flex flex-none gap-base"><button className={secondaryButtonClass} type="button" disabled={busy !== null} onClick={() => void flush()}><Send size={14} />{t(busy === "flush" ? "正在发送…" : "立即 Flush")}</button><button className={primaryButtonClass} type="button" disabled={busy !== null || agentRunning} onClick={() => void save()}>{t(busy === "save" ? "保存中…" : "保存 Trace 设置")}</button></div></footer>
    </div>
  );
}
