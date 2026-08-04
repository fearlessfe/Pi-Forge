import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Globe2,
  LoaderCircle,
  MousePointer2,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrowserAnnotationCapture, BrowserState } from "../contracts";
import { useI18n } from "../i18n";

const initialState: BrowserState = {
  url: "about:blank",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  visible: false,
  annotating: false,
};

type BrowserWorkbenchProps = {
  agentRunning: boolean;
  onClose: () => void;
  onSendToAgent: (markdown: string) => void;
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, "");
}

/* 浏览器工作台工具类组合（token v2，docs-internal/design-refresh-apple.md 3.2/3.5）：
   工具栏/地址栏/状态栏全部走语义 token，浅色主题下不再有深色孤岛。 */
const navButtonClass =
  "grid size-control-md cursor-pointer place-items-center rounded-sm border-0 bg-transparent text-label-3 transition-colors duration-150 ease-apple hover:bg-fill hover:text-label active:bg-fill-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const annotateButtonClass = (active: boolean) =>
  `inline-flex h-control-md cursor-pointer items-center gap-base rounded-sm border border-accent/32 px-loose text-caption font-semibold text-accent transition-colors duration-150 ease-apple active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${active ? "bg-accent/16" : "bg-accent/8 hover:bg-accent/16"}`;
const inlineMessageClass = (tone: "error" | "success") =>
  `grid min-h-control-lg grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-base border-b border-separator px-loose py-base text-caption ${tone === "error" ? "bg-red/8 text-red" : "bg-green/8 text-green"}`;
const inlineMessageButtonClass =
  "inline-flex min-h-control-sm cursor-pointer items-center gap-base rounded-sm border border-current bg-transparent px-base text-caption transition-colors duration-150 ease-apple hover:bg-fill active:bg-fill-2 active:scale-[0.98]";

export function BrowserWorkbench({ agentRunning, onClose, onSendToAgent }: BrowserWorkbenchProps) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState(initialState);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  const [capture, setCapture] = useState<BrowserAnnotationCapture>();
  const [manualAnnotation, setManualAnnotation] = useState(false);

  useEffect(() => {
    if (!window.piDesktop?.browser) {
      setError(t("内置浏览器只能在 Electron 应用中使用。"));
      return;
    }
    const unsubscribe = window.piDesktop.browser.onEvent((event) => {
      setState(event.state);
      if (document.activeElement !== addressRef.current && event.state.url !== "about:blank") setAddress(event.state.url);
    });
    void window.piDesktop.browser.setVisible(true).then((next) => {
      setState(next);
      if (next.url !== "about:blank") setAddress(next.url);
    }).catch((reason: unknown) => setError(errorMessage(reason)));
    return () => {
      unsubscribe();
      void window.piDesktop?.browser.setVisible(false);
    };
  }, [t]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !window.piDesktop?.browser) return;
    const updateBounds = () => {
      const rect = surface.getBoundingClientRect();
      void window.piDesktop?.browser.setBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(surface);
    window.addEventListener("resize", updateBounds);
    const frame = window.requestAnimationFrame(updateBounds);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateBounds);
      observer.disconnect();
    };
  }, []);

  async function run(action: () => Promise<BrowserState>) {
    setError(undefined);
    try {
      setState(await action());
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function navigate() {
    const value = address.trim();
    if (!value || !window.piDesktop?.browser) return;
    setCapture(undefined);
    void run(() => window.piDesktop!.browser.navigate(value));
  }

  async function startAnnotation() {
    if (!window.piDesktop?.browser || manualAnnotation || state.annotating || state.url === "about:blank") return;
    setManualAnnotation(true);
    setCapture(undefined);
    setError(undefined);
    try {
      const result = await window.piDesktop.browser.startAnnotation();
      if (result.result.success) setCapture(result);
      else if (!result.result.cancelled) setError(result.result.reason ?? t("页面标注失败。"));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setManualAnnotation(false);
    }
  }

  const hasPage = state.url !== "about:blank";
  const annotating = manualAnnotation || state.annotating;

  return (
    <main className="absolute inset-0 z-50 flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg shadow-3" aria-label={t("内置浏览器")}>
      <header className="grid min-h-[52px] grid-cols-[auto_minmax(220px,1fr)_auto] items-center gap-loose border-b border-separator bg-bg-grouped px-3 py-base">
        <div className="flex items-center gap-tight" aria-label={t("浏览器导航")}>
          <button className={navButtonClass} type="button" disabled={!state.canGoBack} onClick={() => window.piDesktop?.browser && void run(window.piDesktop.browser.back)} aria-label={t("后退")}><ArrowLeft size={16} /></button>
          <button className={navButtonClass} type="button" disabled={!state.canGoForward} onClick={() => window.piDesktop?.browser && void run(window.piDesktop.browser.forward)} aria-label={t("前进")}><ArrowRight size={16} /></button>
          <button className={navButtonClass} type="button" onClick={() => window.piDesktop?.browser && void run(state.loading ? window.piDesktop.browser.stop : window.piDesktop.browser.reload)} aria-label={t(state.loading ? "停止加载" : "重新加载")}>
            {state.loading ? <X size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>

        <form className="grid h-control-lg min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-base rounded-md border border-separator bg-fill px-loose focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/32" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
          {state.loading ? <LoaderCircle className="is-spinning text-accent" size={14} /> : <ShieldCheck className="text-accent" size={14} />}
          <input
            className="h-full min-w-0 border-0 bg-transparent font-mono text-callout text-label outline-none placeholder:text-label-3"
            ref={addressRef}
            value={address}
            spellCheck={false}
            placeholder={t("输入 localhost 或 HTTPS 地址")}
            aria-label={t("浏览器地址")}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </form>

        <div className="flex items-center gap-base">
          <button
            className={annotateButtonClass(annotating)}
            type="button"
            disabled={!hasPage || (agentRunning && !state.annotating) || annotating}
            onClick={() => void startAnnotation()}
          >
            <MousePointer2 size={14} />
            <span>{t(annotating ? "正在标注" : "标注页面")}</span>
          </button>
          <button className={navButtonClass} type="button" onClick={onClose} aria-label={t("关闭内置浏览器")} title={t("返回当前对话")}>
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="flex min-h-[31px] items-center justify-between gap-card border-b border-separator bg-bg px-card text-caption text-label-3">
        <span className="flex min-w-0 items-center gap-base"><Globe2 size={14} /><strong className="max-w-[420px] truncate font-medium text-label-2">{state.title || t("Frontend Debug Browser")}</strong></span>
        <span className={`flex items-center gap-base ${annotating ? "text-accent" : ""}`}><i className={`size-[6px] rounded-full ${annotating ? "bg-accent" : "bg-label-4"}`} />{t(annotating ? "点击页面元素添加问题说明" : "隔离浏览器会话 · 调试数据保存在本机")}</span>
      </div>

      {error && <div className={inlineMessageClass("error")}><Bug size={14} /><span>{error}</span><button className={inlineMessageButtonClass} type="button" onClick={() => setError(undefined)} aria-label={t("关闭")}><X size={14} /></button></div>}
      {capture && (
        <div className={inlineMessageClass("success")}>
          <MousePointer2 size={14} />
          <span>{t("已捕获 {count} 个元素及当前页面截图。", { count: capture.result.elements.length })}</span>
          <button className={inlineMessageButtonClass} type="button" onClick={() => { onSendToAgent(capture.markdown); setCapture(undefined); }}><Send size={14} />{t("发送给 Agent")}</button>
        </div>
      )}

      <div ref={surfaceRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-bg">
        {!hasPage && (
          <section className="absolute top-[44%] left-1/2 w-[min(650px,calc(100%-56px))] -translate-x-1/2 -translate-y-1/2 text-center">
            <span className="mx-auto mb-card grid size-[58px] place-items-center rounded-lg border border-accent/32 bg-accent/8 text-accent shadow-2"><Bug size={27} /></span>
            <small className="font-mono text-caption font-bold tracking-[0.18em] text-accent">PI VISUAL DEBUGGER</small>
            <h1 className="mx-0 mt-loose mb-loose text-large-title font-semibold tracking-[-0.035em] text-label">{t("在应用内复现、标记并修复前端问题")}</h1>
            <p className="mx-auto max-w-[590px] text-body leading-[1.75] text-label-2">{t("打开本地开发地址或线上页面，然后使用“标注页面”选择元素。Agent 将获得选择器、样式、无障碍信息和截图。")}</p>
            <div className="mt-6 flex justify-center gap-base">
              <span className="flex h-control-lg min-w-[132px] items-center gap-base rounded-md border border-separator bg-fill px-loose text-caption text-label-2"><i className="font-mono text-caption font-bold not-italic text-accent">01</i>{t("打开页面")}</span>
              <span className="flex h-control-lg min-w-[132px] items-center gap-base rounded-md border border-separator bg-fill px-loose text-caption text-label-2"><i className="font-mono text-caption font-bold not-italic text-accent">02</i>{t("选择问题元素")}</span>
              <span className="flex h-control-lg min-w-[132px] items-center gap-base rounded-md border border-separator bg-fill px-loose text-caption text-label-2"><i className="font-mono text-caption font-bold not-italic text-accent">03</i>{t("交给 Agent 修复")}</span>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
