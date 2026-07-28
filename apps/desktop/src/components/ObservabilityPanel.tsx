import { Activity, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
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
    return <div className="settings-panel compact-settings-panel"><div className="settings-loading"><RefreshCw size={17} />{t(busy ? "正在读取 Trace 设置…" : "无法读取 Trace 设置")}</div>{error && <div className="settings-error">{error}</div>}</div>;
  }

  return (
    <div className="settings-panel compact-settings-panel trace-settings-panel">
      <header className="settings-page-header"><div><h2>{t("Trace")}</h2><p>{t("记录 Agent、模型与工具调用，并导出到任何兼容 OTLP 的可观测平台。")}</p></div></header>

      <section className="simple-settings-card trace-overview-card">
        <label className="settings-toggle-row"><span><strong>{t("启用 Agent Trace")}</strong><small>{t("Trace 故障不会中断 Agent 执行。")}</small></span><button className={`switch ${form.enabled ? "is-on" : ""}`} type="button" aria-pressed={form.enabled} onClick={() => { setForm({ ...form, enabled: !form.enabled }); setSaved(false); }}><i /></button></label>
        <label className="settings-toggle-row"><span><strong>{t("本地 Trace 文件")}</strong><small>{status?.localTracePath ?? t("按日期写入受保护的 JSONL 文件")}</small></span><button className={`switch ${form.localFileEnabled ? "is-on" : ""}`} type="button" aria-pressed={form.localFileEnabled} onClick={() => { setForm({ ...form, localFileEnabled: !form.localFileEnabled }); setSaved(false); }}><i /></button></label>
        <label className="settings-toggle-row trace-inline-field"><span><strong>{t("Service Name")}</strong><small>{t("在 Trace 平台中标识这个应用实例")}</small></span><input value={form.serviceName} maxLength={128} onChange={(event) => { setForm({ ...form, serviceName: event.target.value }); setSaved(false); }} /></label>
        <label className="settings-toggle-row trace-inline-field"><span><strong>{t("内容采集")}</strong><small>{t("控制 Prompt、输出和工具参数的采集范围")}</small></span><select className="native-select" value={form.captureContent} onChange={(event) => { setForm({ ...form, captureContent: event.target.value as TraceForm["captureContent"] }); setSaved(false); }}><option value="none">{t("不采集内容")}</option><option value="metadata">{t("仅长度与哈希")}</option><option value="full">{t("完整内容")}</option></select></label>
      </section>

      <section className="trace-exporters-card">
        <header><span><strong>{t("OTLP Exporters")}</strong><small>{t("一个 Span 可同时发送到 Langfuse、Tempo、Jaeger、Datadog 等平台。")}</small></span><button className="secondary-button" type="button" onClick={addExporter}><Plus size={13} />{t("添加 Endpoint")}</button></header>
        {form.exporters.map((exporter, index) => (
          <article className="trace-exporter-row" key={exporter.id ?? `new-${index}`}>
            <div className="trace-exporter-heading"><button className={`switch ${exporter.enabled ? "is-on" : ""}`} type="button" aria-label={t("启用 Exporter")} aria-pressed={exporter.enabled} onClick={() => updateExporter(index, { enabled: !exporter.enabled })}><i /></button><input value={exporter.name} aria-label={t("Exporter 名称")} placeholder="Langfuse" onChange={(event) => updateExporter(index, { name: event.target.value })} /><button type="button" aria-label={t("删除 Exporter")} onClick={() => { setForm({ ...form, exporters: form.exporters.filter((_, candidateIndex) => candidateIndex !== index) }); setSaved(false); }}><Trash2 size={14} /></button></div>
            <label><span>OTLP HTTP Endpoint</span><input value={exporter.endpoint} spellCheck={false} placeholder="https://host.example/api/public/otel" onChange={(event) => updateExporter(index, { endpoint: event.target.value })} /></label>
            <label><span>{t("请求头 JSON")}</span><textarea value={exporter.headerText} spellCheck={false} placeholder={exporter.hasSavedHeaders ? t("留空以保留已加密保存的请求头") : '{"Authorization":"Basic …"}'} onChange={(event) => updateExporter(index, { headerText: event.target.value })} /></label>
            {exporter.hasSavedHeaders && !exporter.headerText && <small className="trace-secret-note">{t("请求头已使用操作系统安全存储加密")}</small>}
          </article>
        ))}
        {form.exporters.length === 0 && <div className="trace-empty"><Activity size={20} /><strong>{t("尚未配置远程 Exporter")}</strong><small>{t("本地 Trace 仍会正常记录；添加任意 OTLP HTTP Endpoint 即可远程导出。")}</small></div>}
      </section>

      {status && <section className="trace-runtime-status"><span><i className={status.lastError ? "is-error" : status.enabled ? "is-ready" : ""} /><strong>{t(status.enabled ? "Trace 运行中" : "Trace 已停用")}</strong></span><small>{t("待发送 Span：{count}", { count: status.queuedSpanCount })}{status.lastExportAt ? ` · ${t("最后导出：{time}", { time: new Date(status.lastExportAt).toLocaleTimeString() })}` : ""}</small>{status.lastError && <em>{status.lastError}</em>}</section>}
      {error && <div className="settings-error" role="alert">{error}</div>}
      {saved && <div className="settings-success">{t("Trace 设置已保存。")}</div>}
      <footer className="trace-settings-footer"><small>{t(agentRunning ? "Agent 正在运行，任务结束后才能修改 Trace 设置。" : "Endpoint 会自动补全 /v1/traces；请求头只保存在操作系统安全存储中。")}</small><div><button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void flush()}><Send size={13} />{t(busy === "flush" ? "正在发送…" : "立即 Flush")}</button><button className="primary-button" type="button" disabled={busy !== null || agentRunning} onClick={() => void save()}>{t(busy === "save" ? "保存中…" : "保存 Trace 设置")}</button></div></footer>
    </div>
  );
}
