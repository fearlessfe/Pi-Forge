import { Cable, CircleAlert, Plus, RefreshCw, Save, Server, Trash2, X } from "lucide-react";
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
    <div className="settings-panel mcp-panel">
      <header className="settings-page-header mcp-header">
        <div><h2>{t("MCP Servers")}</h2><p>{t("连接 stdio 或 Streamable HTTP Server，并将其工具安全地提供给 Agent。")}</p></div>
        <div><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw className={busy === "refresh" ? "is-spinning" : ""} size={13} />{t("刷新")}</button><button className="primary-button" type="button" disabled={agentRunning} onClick={() => setForm({ ...emptyForm })}><Plus size={13} />{t("添加 Server")}</button></div>
      </header>

      {form && <form className="mcp-editor" onSubmit={(event) => void save(event)}>
        <header><span><Server size={16} /><strong>{t(form.previousKey ? "编辑 MCP Server" : "添加 MCP Server")}</strong></span><button type="button" onClick={() => setForm(undefined)} aria-label={t("关闭")}><X size={15} /></button></header>
        <div className="mcp-form-grid">
          <label><span>{t("名称")}</span><input value={form.name} onChange={(event) => update("name", event.target.value)} required /></label>
          <label><span>{t("Server ID")}</span><input value={form.id} onChange={(event) => update("id", event.target.value)} placeholder="filesystem" required /></label>
          <label><span>{t("作用域")}</span><select className="native-select" value={form.scope} disabled={Boolean(form.previousKey)} onChange={(event) => update("scope", event.target.value as McpServerScope)}><option value="user">{t("用户")}</option><option value="project" disabled={!cwd || !projectTrusted}>{t("当前项目")}</option></select></label>
          <label><span>{t("传输")}</span><select className="native-select" value={form.transport} onChange={(event) => update("transport", event.target.value as McpForm["transport"])}><option value="stdio">stdio</option><option value="streamable-http">Streamable HTTP</option></select></label>
          <label><span>{t("超时（秒）")}</span><input type="number" min="1" max="300" value={form.timeoutSeconds} onChange={(event) => update("timeoutSeconds", event.target.value)} required /></label>
          <label className="mcp-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /><span>{t("启用")}</span></label>
        </div>
        {form.transport === "stdio" ? <div className="mcp-form-grid">
          <label className="mcp-wide"><span>{t("命令")}</span><input value={form.command} onChange={(event) => update("command", event.target.value)} placeholder="npx" required /></label>
          <label><span>{t("参数（每行一个）")}</span><textarea value={form.args} onChange={(event) => update("args", event.target.value)} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."} /></label>
          <label><span>{t("工作目录")}</span><input value={form.workingDirectory} onChange={(event) => update("workingDirectory", event.target.value)} placeholder={form.scope === "project" ? "." : t("可选")} /></label>
          <label><span>{t("环境变量 JSON")}</span><textarea value={form.environment} onChange={(event) => update("environment", event.target.value)} spellCheck={false} /></label>
          <label><span>{t("私密环境变量 JSON")}</span><textarea value={form.secretEnvironment} onChange={(event) => update("secretEnvironment", event.target.value)} placeholder='{"API_KEY":"…"}' spellCheck={false} /></label>
        </div> : <div className="mcp-form-grid">
          <label className="mcp-wide"><span>{t("Server URL")}</span><input type="url" value={form.url} onChange={(event) => update("url", event.target.value)} placeholder="https://example.com/mcp" required /></label>
          <label><span>{t("请求头 JSON")}</span><textarea value={form.headers} onChange={(event) => update("headers", event.target.value)} spellCheck={false} /></label>
          <label><span>{t("私密请求头 JSON")}</span><textarea value={form.secretHeaders} onChange={(event) => update("secretHeaders", event.target.value)} placeholder='{"Authorization":"Bearer …"}' spellCheck={false} /></label>
        </div>}
        {form.previousKey && <label className="mcp-clear-credentials"><input type="checkbox" checked={form.clearCredentials} onChange={(event) => update("clearCredentials", event.target.checked)} />{t("删除此前安全保存的凭据")}</label>}
        <footer><small>{t("私密字段使用操作系统安全存储加密，不写入 MCP 配置文件，也不会回显到界面。")}</small><button className="primary-button" type="submit" disabled={busy === "save" || agentRunning}><Save size={13} />{t(busy === "save" ? "保存中…" : "保存")}</button></footer>
      </form>}

      {!projectTrusted && cwd && <div className="mcp-trust-note"><CircleAlert size={14} /><span>{t("当前项目未受信任，因此不会读取或运行 .pi/mcp.json。用户级 Server 仍可使用。")}</span></div>}
      <section className="mcp-server-list">
        {overview.servers.map((server) => {
          const runtime = overview.runtimes.find((entry) => entry.key === server.key);
          return <article key={server.key}>
            <span className={`mcp-state is-${runtime?.state ?? "disconnected"}`}><Cable size={15} /></span>
            <span className="mcp-server-copy"><strong>{server.name}</strong><small>{server.scope} · {server.transport.type} · {server.id}{server.hasCredentials ? ` · ${t("凭据已保存")}` : ""}</small>{runtime?.error && <em>{runtime.error}</em>}{runtime?.tools.length ? <span className="mcp-tools">{runtime.tools.map((tool) => <code key={tool.remoteName}>{tool.remoteName}</code>)}</span> : null}</span>
            <span className={`policy-badge ${runtime?.state === "connected" ? "policy-badge--allowed" : ""}`}>{t(runtime?.state ?? (server.enabled ? "disconnected" : "disabled"))}</span>
            <span className="mcp-actions"><button type="button" disabled={Boolean(busy) || !server.enabled} onClick={() => void action(runtime?.state === "connected" ? "disconnect" : "connect", server.key)}>{t(runtime?.state === "connected" ? "断开" : "连接")}</button><button type="button" disabled={Boolean(busy) || !server.enabled} onClick={() => void action("reconnect", server.key)}>{t("重连")}</button><button type="button" disabled={Boolean(busy) || agentRunning} onClick={() => setForm(editForm(server))}>{t("编辑")}</button><button type="button" disabled={Boolean(busy) || agentRunning} onClick={() => void action("remove", server.key)} aria-label={t("删除")}><Trash2 size={13} /></button></span>
          </article>;
        })}
        {overview.servers.length === 0 && <div className="skills-empty"><Cable size={20} /><strong>{t("尚未配置 MCP Server")}</strong><span>{t("添加一个用户级或可信项目级 Server。")}</span></div>}
      </section>

      {overview.logs.length > 0 && <details className="mcp-logs"><summary>{t("连接日志")} <small>{overview.logs.length}</small></summary>{overview.logs.slice(-80).reverse().map((entry) => <div className={entry.level === "error" ? "is-error" : ""} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><code>{overview.servers.find((server) => server.key === entry.serverKey)?.id ?? entry.serverKey}</code><span>{entry.message}</span></div>)}</details>}
      {agentRunning && <p className="permission-inline-note">{t("任务运行期间不能修改 MCP 配置；连接状态仍可查看。")}</p>}
      {error && <div className="settings-error" role="alert">{error}</div>}
    </div>
  );
}
