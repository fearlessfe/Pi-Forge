import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
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

/* xterm 主题不在 TSX 里维护两套硬编码色值：从 styles.css 主题变量层的 --terminal-*
   读取（docs/design-refresh-apple.md 3.6），主题切换由 dataset.theme 驱动。 */
function terminalVar(styles: CSSStyleDeclaration, name: string): string | undefined {
  return styles.getPropertyValue(name).trim() || undefined;
}

function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: terminalVar(styles, "--terminal-background"),
    foreground: terminalVar(styles, "--terminal-foreground"),
    cursor: terminalVar(styles, "--terminal-cursor"),
    selectionBackground: terminalVar(styles, "--terminal-selection"),
    black: terminalVar(styles, "--terminal-black"),
    red: terminalVar(styles, "--terminal-red"),
    green: terminalVar(styles, "--terminal-green"),
    yellow: terminalVar(styles, "--terminal-yellow"),
    blue: terminalVar(styles, "--terminal-blue"),
    magenta: terminalVar(styles, "--terminal-magenta"),
    cyan: terminalVar(styles, "--terminal-cyan"),
    white: terminalVar(styles, "--terminal-white"),
    brightBlack: terminalVar(styles, "--terminal-bright-black"),
    brightRed: terminalVar(styles, "--terminal-bright-red"),
    brightGreen: terminalVar(styles, "--terminal-bright-green"),
    brightYellow: terminalVar(styles, "--terminal-bright-yellow"),
    brightBlue: terminalVar(styles, "--terminal-bright-blue"),
    brightMagenta: terminalVar(styles, "--terminal-bright-magenta"),
    brightCyan: terminalVar(styles, "--terminal-bright-cyan"),
    brightWhite: terminalVar(styles, "--terminal-bright-white"),
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

/* 终端面板工具类组合（token v2，docs/design-refresh-apple.md 3.2/3.5）：
   外壳 bg-bg-grouped + shadow-3；工作区底色走 --terminal-background（bg-terminal-bg），
   与 xterm 渲染进程内主题同步（3.6）保持一致，浅色主题下不再是深色孤岛。 */
const panelShellClass =
  "absolute inset-x-3.5 bottom-3.5 z-40 grid h-[min(46%,430px)] min-h-[260px] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-separator bg-bg-grouped shadow-3";
const headerIconButtonClass =
  "grid size-control-sm cursor-pointer place-items-center rounded-sm border-0 bg-transparent text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label active:bg-fill-2 active:scale-[0.98]";
const terminalTabClass = (active: boolean) =>
  active
    ? "flex h-control-sm min-w-[105px] max-w-[190px] items-center gap-base rounded-t-sm bg-terminal-bg pr-tight text-caption text-label"
    : "flex h-control-sm min-w-[105px] max-w-[190px] items-center gap-base rounded-t-sm pr-tight text-caption text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label-2";

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
      theme: readTerminalTheme(),
    });
    terminal.open(host.current);
    register(session.id, terminal);
    // 主题切换时（App 写 documentElement.dataset.theme）同步刷新 xterm 配色。
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
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
      themeObserver.disconnect();
      dataDisposable.dispose();
      register(session.id);
      terminal.dispose();
    };
  }, [session.id]);

  useEffect(() => {
    if (active) host.current?.querySelector("textarea")?.focus();
  }, [active]);

  return <div className={`terminal-pane absolute inset-0 pt-base pr-tight pb-tight pl-loose ${active ? "block" : "hidden"}`} ref={host} aria-hidden={!active} />;
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

  return <section className={panelShellClass} aria-label={t("集成终端")}>
    <header className="flex h-control-lg items-center gap-base border-b border-separator pr-base pl-3">
      <span className="flex min-w-0 flex-1 items-center gap-base"><SquareTerminal size={16} className="text-label-3" /><strong className="text-caption font-semibold text-label">{t("终端")}</strong><small className="truncate text-caption text-label-3">{t("由你直接控制；不经过 Agent 权限与沙箱策略")}</small></span>
      {activeServiceUrl && <button className="inline-flex h-control-sm max-w-[230px] cursor-pointer items-center gap-base rounded-sm border border-accent/32 bg-accent/8 px-base text-caption font-semibold whitespace-nowrap text-accent transition-colors duration-150 ease-apple hover:bg-accent/16 active:scale-[0.98]" type="button" onClick={() => onOpenInBrowser(activeServiceUrl)} title={activeServiceUrl}>
        <Globe2 size={14} /><span className="truncate">{t("在内置浏览器中打开")}</span><code className="font-mono text-caption text-label-3">{new URL(activeServiceUrl).port}</code>
      </button>}
      <button className={headerIconButtonClass} type="button" onClick={() => void createTerminal()} aria-label={t("新建终端")}><Plus size={14} /></button>
      <button className={headerIconButtonClass} type="button" onClick={onClose} aria-label={t("关闭终端面板")}><X size={14} /></button>
    </header>
    <nav className="flex items-end gap-tight overflow-x-auto border-b border-separator px-base pt-tight" aria-label={t("终端标签页")}>
      {sessions.map((session) => <span className={terminalTabClass(activeId === session.id)} key={session.id}><button className="flex min-w-0 flex-1 cursor-pointer items-center gap-base border-0 bg-transparent pl-loose text-inherit" type="button" onClick={() => setActiveId(session.id)}><span className="min-w-0 flex-1 truncate text-left">{session.title}</span>{session.status === "exited" && <em className="font-mono text-caption not-italic text-red">{session.exitCode}</em>}</button><button className="grid cursor-pointer place-items-center border-0 bg-transparent p-tight text-inherit text-label-4 hover:text-label" type="button" aria-label={t("关闭 {name}", { name: session.title })} onClick={() => void closeTerminal(session.id)}><X size={14} /></button></span>)}
    </nav>
    <div className="relative min-h-0 bg-terminal-bg">
      {sessions.map((session) => <TerminalPane key={session.id} session={session} active={activeId === session.id} register={register} />)}
      {sessions.length === 0 && <div className="flex h-full flex-col items-center justify-center gap-base text-caption text-label-3"><SquareTerminal size={18} /><span>{t("没有打开的终端")}</span><button className="cursor-pointer rounded-sm border border-separator bg-bg-grouped-2 px-loose py-base text-caption font-semibold text-label-2 transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98]" type="button" onClick={() => void createTerminal()}>{t("新建终端")}</button></div>}
    </div>
    {error && <div className="absolute inset-x-[10px] bottom-2 rounded-sm border border-red/32 bg-red/8 px-base py-base text-caption text-red" role="alert">{error}</div>}
  </section>;
}
