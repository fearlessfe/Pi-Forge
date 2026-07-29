import { Cable, ChevronDown, CircleAlert, Plus, RefreshCw, Save, Server, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { McpOverview, McpServerConfig, McpServerScope, SaveMcpServerInput } from "../contracts";
import { useI18n } from "../i18n";

type McpPanelProps = {
  cwd?: string;
  projectTrusted: boolean;
  agentRunning: boolean;
};

type McpForm = {
  previousKey?: string;
  id: string;
  name: string;
  scope: McpServerScope;
  enabled: boolean;
  timeoutSeconds: string;
  transport: "stdio" | "streamable-http";
  command: string;
  args: string;
  workingDirectory: string;
  url: string;
  environment: string;
  headers: string;
  secretEnvironment: string;
  secretHeaders: string;
  clearCredentials: boolean;
};

const emptyForm: McpForm = {
  id: "",
  name: "",
  scope: "user",
  enabled: true,
  timeoutSeconds: "60",
  transport: "stdio",
  command: "",
  args: "",
  workingDirectory: "",
  url: "",
  environment: "{}",
  headers: "{}",
  secretEnvironment: "{}",
  secretHeaders: "{}",
  clearCredentials: false,
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

/* 设置面板共享工具类组合（token v2，docs/design-refresh-apple.md 3.2/3.5）：
   与 D3-1 SettingsView 同一语言 —— 按钮 text-body/600 + control 档；
   表单控件 bg-fill + border-separator + rounded-sm + focus-visible:ring-2 ring-accent/32。 */
const primaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-base rounded-sm border-0 bg-accent px-card text-body font-semibold text-accent-ink transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const secondaryButtonClass =
  "inline-flex h-control-lg cursor-pointer items-center justify-center gap-base rounded-sm border border-separator bg-bg-grouped-2 px-card text-body font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const formInputClass =
  "h-control-lg w-full rounded-sm border border-separator bg-fill px-loose text-body font-normal text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40";
const formTextareaClass =
  "min-h-[92px] w-full resize-y rounded-sm border border-separator bg-fill px-loose py-base font-mono text-caption font-normal text-label outline-none placeholder:text-label-3 focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40";
const nativeSelectClass =
  "h-control-lg w-full cursor-pointer appearance-none rounded-sm border border-separator bg-fill pr-8 pl-loose text-body font-normal text-label outline-none focus-visible:ring-2 focus-visible:ring-accent/32 disabled:pointer-events-none disabled:opacity-40";
const nativeSelectChevronClass = "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-label-3";
const fieldLabelClass = "grid gap-base text-caption font-semibold text-label-2";
const settingsErrorClass = "mt-loose rounded-sm border border-red/32 bg-red/8 px-loose py-loose text-caption text-red";
const permissionNoteClass = "mt-loose mr-0.5 ml-0.5 text-caption leading-[1.55] text-orange";
const policyBadgeClass = (allowed: boolean) =>
  allowed
    ? "flex-none rounded-full border border-green/32 bg-green/8 px-base py-base text-mini text-green"
    : "flex-none rounded-full border border-orange/32 bg-orange/8 px-base py-base text-mini text-orange";

function parseRecord(value: string, label: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error(`${label}必须是有效的 JSON 对象。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}必须是字符串键值对 JSON 对象。`);
  }
  return parsed as Record<string, string>;
}

function editForm(server: McpServerConfig): McpForm {
  return {
    previousKey: server.key,
    id: server.id,
    name: server.name,
    scope: server.scope,
    enabled: server.enabled,
    timeoutSeconds: String(server.timeoutMs / 1_000),
    transport: server.transport.type,
    command: server.transport.type === "stdio" ? server.transport.command : "",
    args: server.transport.type === "stdio" ? server.transport.args.join("\n") : "",
    workingDirectory: server.transport.type === "stdio" ? server.transport.cwd ?? "" : "",
    url: server.transport.type === "streamable-http" ? server.transport.url : "",
    environment: JSON.stringify(server.transport.type === "stdio" ? server.transport.environment : {}, null, 2),
    headers: JSON.stringify(server.transport.type === "streamable-http" ? server.transport.headers : {}, null, 2),
    secretEnvironment: "{}",
    secretHeaders: "{}",
    clearCredentials: false,
  };
}

export function McpPanel({ cwd, projectTrusted, agentRunning }: McpPanelProps) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<McpOverview>({ servers: [], runtimes: [], logs: [] });
  const [form, setForm] = useState<McpForm>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    if (!window.piDesktop?.mcp) return;
    setBusy("refresh");
    setError("");
    try {
      setOverview(await window.piDesktop.mcp.overview(cwd));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  useEffect(() => { void refresh(); }, [cwd, projectTrusted]);

  function update<Key extends keyof McpForm>(key: Key, value: McpForm[Key]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !window.piDesktop?.mcp) return;
    setBusy("save");
    setError("");
    try {
      const timeoutMs = Number(form.timeoutSeconds) * 1_000;
      const common = {
        previousKey: form.previousKey,
        id: form.id,
        name: form.name,
        scope: form.scope,
        projectPath: form.scope === "project" ? cwd : undefined,
        enabled: form.enabled,
        timeoutMs,
        clearCredentials: form.clearCredentials,
      };
      const input: SaveMcpServerInput = form.transport === "stdio"
        ? {
          ...common,
          transport: {
            type: "stdio",
            command: form.command,
            args: form.args.split("\n").map((entry) => entry.trim()).filter(Boolean),
            cwd: form.workingDirectory.trim() || undefined,
            environment: parseRecord(form.environment, t("环境变量")),
          },
          secretEnvironment: parseRecord(form.secretEnvironment, t("私密环境变量")),
        }
        : {
          ...common,
          transport: { type: "streamable-http", url: form.url, headers: parseRecord(form.headers, t("请求头")) },
          secretHeaders: parseRecord(form.secretHeaders, t("私密请求头")),
        };
      setOverview(await window.piDesktop.mcp.save(input));
      setForm(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function action(kind: "connect" | "disconnect" | "reconnect" | "remove", key: string) {
    if (!window.piDesktop?.mcp) return;
    setBusy(`${kind}:${key}`);
    setError("");
    try {
      setOverview(await window.piDesktop.mcp[kind](key, cwd));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid w-full max-w-[820px] content-start gap-card">
      <header className="flex min-h-[62px] items-start justify-between gap-5">
        <div className="min-w-0"><h2 className="mb-2 text-large-title font-semibold text-label">{t("MCP Servers")}</h2><p className="text-body text-label-2">{t("连接 stdio 或 Streamable HTTP Server，并将其工具安全地提供给 Agent。")}</p></div>
        <div className="flex items-center gap-base"><button className={secondaryButtonClass} type="button" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw className={busy === "refresh" ? "is-spinning" : ""} size={14} />{t("刷新")}</button><button className={primaryButtonClass} type="button" disabled={agentRunning} onClick={() => setForm({ ...emptyForm })}><Plus size={14} />{t("添加 Server")}</button></div>
      </header>

      {form && <form className="rounded-md border border-separator bg-bg-grouped p-card" onSubmit={(event) => void save(event)}>
        <header className="mb-card flex items-center justify-between"><span className="inline-flex items-center gap-base text-label"><Server size={16} /><strong className="text-body font-semibold">{t(form.previousKey ? "编辑 MCP Server" : "添加 MCP Server")}</strong></span><button className="grid size-control-sm cursor-pointer place-items-center rounded-sm border-0 bg-transparent text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label active:bg-fill-2 active:scale-[0.98]" type="button" onClick={() => setForm(undefined)} aria-label={t("关闭")}><X size={16} /></button></header>
        <div className="grid grid-cols-2 gap-3 max-[1080px]:grid-cols-1">
          <label className={fieldLabelClass}><span>{t("名称")}</span><input className={formInputClass} value={form.name} onChange={(event) => update("name", event.target.value)} required /></label>
          <label className={fieldLabelClass}><span>{t("Server ID")}</span><input className={formInputClass} value={form.id} onChange={(event) => update("id", event.target.value)} placeholder="filesystem" required /></label>
          <label className={fieldLabelClass}><span>{t("作用域")}</span><span className="relative block"><select className={nativeSelectClass} value={form.scope} disabled={Boolean(form.previousKey)} onChange={(event) => update("scope", event.target.value as McpServerScope)}><option value="user">{t("用户")}</option><option value="project" disabled={!cwd || !projectTrusted}>{t("当前项目")}</option></select><ChevronDown size={14} className={nativeSelectChevronClass} /></span></label>
          <label className={fieldLabelClass}><span>{t("传输")}</span><span className="relative block"><select className={nativeSelectClass} value={form.transport} onChange={(event) => update("transport", event.target.value as McpForm["transport"])}><option value="stdio">stdio</option><option value="streamable-http">Streamable HTTP</option></select><ChevronDown size={14} className={nativeSelectChevronClass} /></span></label>
          <label className={fieldLabelClass}><span>{t("超时（秒）")}</span><input className={formInputClass} type="number" min="1" max="300" value={form.timeoutSeconds} onChange={(event) => update("timeoutSeconds", event.target.value)} required /></label>
          <label className="inline-flex min-h-control-lg cursor-pointer items-center gap-base self-end text-caption font-semibold text-label-2"><input className="size-4 accent-accent" type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /><span>{t("启用")}</span></label>
        </div>
        {form.transport === "stdio" ? <div className="mt-3 grid grid-cols-2 gap-3 max-[1080px]:grid-cols-1">
          <label className={`${fieldLabelClass} col-span-2 max-[1080px]:col-span-1`}><span>{t("命令")}</span><input className={formInputClass} value={form.command} onChange={(event) => update("command", event.target.value)} placeholder="npx" required /></label>
          <label className={fieldLabelClass}><span>{t("参数（每行一个）")}</span><textarea className={formTextareaClass} value={form.args} onChange={(event) => update("args", event.target.value)} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."} /></label>
          <label className={fieldLabelClass}><span>{t("工作目录")}</span><input className={formInputClass} value={form.workingDirectory} onChange={(event) => update("workingDirectory", event.target.value)} placeholder={form.scope === "project" ? "." : t("可选")} /></label>
          <label className={fieldLabelClass}><span>{t("环境变量 JSON")}</span><textarea className={formTextareaClass} value={form.environment} onChange={(event) => update("environment", event.target.value)} spellCheck={false} /></label>
          <label className={fieldLabelClass}><span>{t("私密环境变量 JSON")}</span><textarea className={formTextareaClass} value={form.secretEnvironment} onChange={(event) => update("secretEnvironment", event.target.value)} placeholder='{"API_KEY":"…"}' spellCheck={false} /></label>
        </div> : <div className="mt-3 grid grid-cols-2 gap-3 max-[1080px]:grid-cols-1">
          <label className={`${fieldLabelClass} col-span-2 max-[1080px]:col-span-1`}><span>{t("Server URL")}</span><input className={formInputClass} type="url" value={form.url} onChange={(event) => update("url", event.target.value)} placeholder="https://example.com/mcp" required /></label>
          <label className={fieldLabelClass}><span>{t("请求头 JSON")}</span><textarea className={formTextareaClass} value={form.headers} onChange={(event) => update("headers", event.target.value)} spellCheck={false} /></label>
          <label className={fieldLabelClass}><span>{t("私密请求头 JSON")}</span><textarea className={formTextareaClass} value={form.secretHeaders} onChange={(event) => update("secretHeaders", event.target.value)} placeholder='{"Authorization":"Bearer …"}' spellCheck={false} /></label>
        </div>}
        {form.previousKey && <label className="mt-loose inline-flex cursor-pointer items-center gap-base text-caption font-semibold text-label-2"><input className="size-4 accent-accent" type="checkbox" checked={form.clearCredentials} onChange={(event) => update("clearCredentials", event.target.checked)} />{t("删除此前安全保存的凭据")}</label>}
        <footer className="mt-card flex items-center justify-between gap-card border-t border-separator pt-card"><small className="text-caption text-label-3">{t("私密字段使用操作系统安全存储加密，不写入 MCP 配置文件，也不会回显到界面。")}</small><button className={primaryButtonClass} type="submit" disabled={busy === "save" || agentRunning}><Save size={14} />{t(busy === "save" ? "保存中…" : "保存")}</button></footer>
      </form>}

      {!projectTrusted && cwd && <div className="flex items-center gap-base rounded-sm border border-orange/32 bg-orange/8 px-loose py-loose text-callout text-label-2"><CircleAlert size={14} /><span>{t("当前项目未受信任，因此不会读取或运行 .pi/mcp.json。用户级 Server 仍可使用。")}</span></div>}
      <section className="grid gap-loose">
        {overview.servers.map((server) => {
          const runtime = overview.runtimes.find((entry) => entry.key === server.key);
          return <article className="flex items-center gap-3 rounded-md border border-separator bg-bg-grouped p-card max-[1080px]:flex-wrap max-[1080px]:items-start" key={server.key}>
            <span className={`mcp-state is-${runtime?.state ?? "disconnected"}`}><Cable size={16} /></span>
            <span className="grid min-w-0 flex-1 gap-tight"><strong className="text-body font-semibold text-label">{server.name}</strong><small className="truncate text-caption text-label-3">{server.scope} · {server.transport.type} · {server.id}{server.hasCredentials ? ` · ${t("凭据已保存")}` : ""}</small>{runtime?.error && <em className="truncate text-caption not-italic text-red">{runtime.error}</em>}{runtime?.tools.length ? <span className="flex flex-wrap gap-tight">{runtime.tools.map((tool) => <code className="rounded-sm bg-fill px-base py-tight font-mono text-caption text-label-2" key={tool.remoteName}>{tool.remoteName}</code>)}</span> : null}</span>
            <span className={policyBadgeClass(runtime?.state === "connected")}>{t(runtime?.state ?? (server.enabled ? "disconnected" : "disabled"))}</span>
            <span className="flex items-center gap-base max-[1080px]:w-full max-[1080px]:justify-end"><button className="cursor-pointer border-0 bg-transparent text-caption font-semibold text-label-2 transition-colors duration-150 ease-apple hover:text-label active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={Boolean(busy) || !server.enabled} onClick={() => void action(runtime?.state === "connected" ? "disconnect" : "connect", server.key)}>{t(runtime?.state === "connected" ? "断开" : "连接")}</button><button className="cursor-pointer border-0 bg-transparent text-caption font-semibold text-label-2 transition-colors duration-150 ease-apple hover:text-label active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={Boolean(busy) || !server.enabled} onClick={() => void action("reconnect", server.key)}>{t("重连")}</button><button className="cursor-pointer border-0 bg-transparent text-caption font-semibold text-label-2 transition-colors duration-150 ease-apple hover:text-label active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={Boolean(busy) || agentRunning} onClick={() => setForm(editForm(server))}>{t("编辑")}</button><button className="cursor-pointer border-0 bg-transparent text-caption font-semibold text-label-2 transition-colors duration-150 ease-apple hover:text-label active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40" type="button" disabled={Boolean(busy) || agentRunning} onClick={() => void action("remove", server.key)} aria-label={t("删除")}><Trash2 size={14} /></button></span>
          </article>;
        })}
        {overview.servers.length === 0 && <div className="grid min-h-[180px] place-items-center content-center gap-base text-caption text-label-3"><Cable size={18} /><strong className="text-label-2">{t("尚未配置 MCP Server")}</strong><span>{t("添加一个用户级或可信项目级 Server。")}</span></div>}
      </section>

      {overview.logs.length > 0 && <details className="rounded-md border border-separator bg-bg-grouped px-card py-3"><summary className="cursor-pointer text-callout text-label-2">{t("连接日志")} <small className="ml-base text-label-3">{overview.logs.length}</small></summary>{overview.logs.slice(-80).reverse().map((entry) => <div className="grid grid-cols-[76px_110px_minmax(0,1fr)] gap-base pt-2 text-caption text-label-3" key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><code className="font-mono">{overview.servers.find((server) => server.key === entry.serverKey)?.id ?? entry.serverKey}</code><span className={entry.level === "error" ? "text-red" : ""}>{entry.message}</span></div>)}</details>}
      {agentRunning && <p className={permissionNoteClass}>{t("任务运行期间不能修改 MCP 配置；连接状态仍可查看。")}</p>}
      {error && <div className={settingsErrorClass} role="alert">{error}</div>}
    </div>
  );
}
