import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Globe2, Plus, SquareTerminal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalEvent, TerminalSessionInfo } from "../contracts";
import { useI18n } from "../i18n";
import { detectLocalServiceUrls } from "../terminal-urls";

type TerminalPanelProps = {
  cwd?: string;
  onClose: () => void;
  onOpenInBrowser: (url: string) => void;
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function TerminalPane({ session, active, register }: {
  session: TerminalSessionInfo;
  active: boolean;
  register: (id: string, terminal?: Terminal) => void;
}) {
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Geist Mono", "SFMono-Regular", "Cascadia Code", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: "#090c11",
        foreground: "#d7dee6",
        cursor: "#7bf1a8",
        selectionBackground: "#324253",
        black: "#090c11",
        red: "#ff8585",
        green: "#65d98d",
        yellow: "#f4c76b",
        blue: "#73a9ff",
        magenta: "#c49cff",
        cyan: "#65d8d2",
        white: "#eef2f5",
      },
    });
    terminal.open(host.current);
    register(session.id, terminal);
    const dataDisposable = terminal.onData((data) => void window.piDesktop?.terminal.write(session.id, data));
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      const cols = Math.max(20, Math.floor(width / 7.3));
      const rows = Math.max(4, Math.floor(height / 15));
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.resize(cols, rows);
        void window.piDesktop?.terminal.resize(session.id, cols, rows);
      }
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      register(session.id);
      terminal.dispose();
    };
  }, [session.id]);

  useEffect(() => {
    if (active) host.current?.querySelector("textarea")?.focus();
  }, [active]);

  return <div className={`terminal-pane ${active ? "is-active" : ""}`} ref={host} aria-hidden={!active} />;
}

export function TerminalPanel({ cwd, onClose, onOpenInBrowser }: TerminalPanelProps) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState("");
  const [serviceUrls, setServiceUrls] = useState<Record<string, string[]>>({});
  const terminals = useRef(new Map<string, Terminal>());
  const pendingOutput = useRef(new Map<string, string>());
  const urlScanBuffers = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.piDesktop?.terminal.onEvent((event: TerminalEvent) => {
      if (cancelled) return;
      if (event.type === "terminal.data") {
        const scanBuffer = `${urlScanBuffers.current.get(event.id) ?? ""}${event.data}`.slice(-4_096);
        urlScanBuffers.current.set(event.id, scanBuffer);
        const detectedUrls = detectLocalServiceUrls(scanBuffer);
        if (detectedUrls.length > 0) {
          setServiceUrls((current) => {
            const next = [...new Set([...(current[event.id] ?? []), ...detectedUrls])];
            return next.length === (current[event.id]?.length ?? 0) ? current : { ...current, [event.id]: next };
          });
        }
        const terminal = terminals.current.get(event.id);
        if (terminal) terminal.write(event.data);
        else pendingOutput.current.set(event.id, `${pendingOutput.current.get(event.id) ?? ""}${event.data}`.slice(-1_000_000));
      } else {
        setSessions((current) => current.map((session) => session.id === event.id ? { ...session, status: "exited", exitCode: event.exitCode } : session));
        terminals.current.get(event.id)?.write(`\r\n\x1b[90m[process exited with code ${event.exitCode}]\x1b[0m\r\n`);
      }
    });
    const api = window.piDesktop?.terminal;
    const initializationTimer = window.setTimeout(() => {
      void api?.list().then(async (current) => {
        if (cancelled) return;
        const running = current.filter((session) => session.status === "running");
        setSessions(running);
        setActiveId((value) => value ?? running[0]?.id);
        if (running.length === 0) {
          const session = await api.create(cwd, 100, 26);
          if (cancelled) {
            await api.kill(session.id).catch(() => undefined);
            return;
          }
          setSessions([session]);
          setActiveId(session.id);
        }
      }).catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(initializationTimer);
      unsubscribe?.();
    };
  }, [cwd]);

  async function createTerminal() {
    if (!window.piDesktop?.terminal) return;
    setError("");
    try {
      const session = await window.piDesktop.terminal.create(cwd, 100, 26);
      setSessions((current) => current.some((entry) => entry.id === session.id) ? current : [...current, session]);
      setActiveId(session.id);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function closeTerminal(id: string) {
    await window.piDesktop?.terminal.kill(id).catch((caught: unknown) => setError(errorMessage(caught)));
    pendingOutput.current.delete(id);
    urlScanBuffers.current.delete(id);
    setServiceUrls((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSessions((current) => {
      const next = current.filter((session) => session.id !== id);
      setActiveId((active) => active === id ? next[0]?.id : active);
      return next;
    });
  }

  function register(id: string, terminal?: Terminal) {
    if (!terminal) {
      terminals.current.delete(id);
      return;
    }
    terminals.current.set(id, terminal);
    const pending = pendingOutput.current.get(id);
    if (pending) {
      terminal.write(pending);
      pendingOutput.current.delete(id);
    }
  }

  const activeServiceUrl = activeId ? serviceUrls[activeId]?.at(-1) : undefined;

  return <section className="terminal-panel" aria-label={t("集成终端")}>
    <header className="terminal-panel-header">
      <span><SquareTerminal size={15} /><strong>{t("终端")}</strong><small>{t("由你直接控制；不经过 Agent 权限与沙箱策略")}</small></span>
      {activeServiceUrl && <button className="terminal-browser-button" type="button" onClick={() => onOpenInBrowser(activeServiceUrl)} title={activeServiceUrl}>
        <Globe2 size={13} /><span>{t("在内置浏览器中打开")}</span><code>{new URL(activeServiceUrl).port}</code>
      </button>}
      <button type="button" onClick={() => void createTerminal()} aria-label={t("新建终端")}><Plus size={14} /></button>
      <button type="button" onClick={onClose} aria-label={t("关闭终端面板")}><X size={14} /></button>
    </header>
    <nav className="terminal-tabs" aria-label={t("终端标签页")}>
      {sessions.map((session) => <span className={`terminal-tab ${activeId === session.id ? "is-active" : ""}`} key={session.id}><button type="button" onClick={() => setActiveId(session.id)}><span>{session.title}</span>{session.status === "exited" && <em>{session.exitCode}</em>}</button><button className="terminal-tab-close" type="button" aria-label={t("关闭 {name}", { name: session.title })} onClick={() => void closeTerminal(session.id)}><X size={11} /></button></span>)}
    </nav>
    <div className="terminal-workspace">
      {sessions.map((session) => <TerminalPane key={session.id} session={session} active={activeId === session.id} register={register} />)}
      {sessions.length === 0 && <div className="terminal-empty"><SquareTerminal size={22} /><span>{t("没有打开的终端")}</span><button type="button" onClick={() => void createTerminal()}>{t("新建终端")}</button></div>}
    </div>
    {error && <div className="terminal-error" role="alert">{error}</div>}
  </section>;
}
