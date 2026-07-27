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
    <main className="browser-workbench" aria-label={t("内置浏览器")}>
      <header className="browser-toolbar">
        <div className="browser-nav-controls" aria-label={t("浏览器导航")}>
          <button type="button" disabled={!state.canGoBack} onClick={() => window.piDesktop?.browser && void run(window.piDesktop.browser.back)} aria-label={t("后退")}><ArrowLeft size={15} /></button>
          <button type="button" disabled={!state.canGoForward} onClick={() => window.piDesktop?.browser && void run(window.piDesktop.browser.forward)} aria-label={t("前进")}><ArrowRight size={15} /></button>
          <button type="button" onClick={() => window.piDesktop?.browser && void run(state.loading ? window.piDesktop.browser.stop : window.piDesktop.browser.reload)} aria-label={t(state.loading ? "停止加载" : "重新加载")}>
            {state.loading ? <X size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>

        <form className="browser-address" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
          {state.loading ? <LoaderCircle className="is-spinning" size={14} /> : <ShieldCheck size={14} />}
          <input
            ref={addressRef}
            value={address}
            spellCheck={false}
            placeholder={t("输入 localhost 或 HTTPS 地址")}
            aria-label={t("浏览器地址")}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </form>

        <div className="browser-toolbar-actions">
          <button
            className={`browser-annotate-button ${annotating ? "is-active" : ""}`}
            type="button"
            disabled={!hasPage || (agentRunning && !state.annotating) || annotating}
            onClick={() => void startAnnotation()}
          >
            <MousePointer2 size={14} />
            <span>{t(annotating ? "正在标注" : "标注页面")}</span>
          </button>
          <button className="browser-close-button" type="button" onClick={onClose} aria-label={t("关闭内置浏览器")} title={t("返回当前对话")}>
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="browser-meta-row">
        <span><Globe2 size={12} /><strong>{state.title || t("Frontend Debug Browser")}</strong></span>
        <span className={annotating ? "browser-debug-state is-active" : "browser-debug-state"}><i />{t(annotating ? "点击页面元素添加问题说明" : "隔离浏览器会话 · 调试数据保存在本机")}</span>
      </div>

      {error && <div className="browser-inline-message is-error"><Bug size={14} /><span>{error}</span><button type="button" onClick={() => setError(undefined)} aria-label={t("关闭")}><X size={13} /></button></div>}
      {capture && (
        <div className="browser-inline-message is-success">
          <MousePointer2 size={14} />
          <span>{t("已捕获 {count} 个元素及当前页面截图。", { count: capture.result.elements.length })}</span>
          <button type="button" onClick={() => { onSendToAgent(capture.markdown); setCapture(undefined); }}><Send size={13} />{t("发送给 Agent")}</button>
        </div>
      )}

      <div ref={surfaceRef} className={`browser-native-surface ${hasPage ? "has-page" : ""}`}>
        {!hasPage && (
          <section className="browser-welcome">
            <span className="browser-welcome-icon"><Bug size={27} /></span>
            <small>PI VISUAL DEBUGGER</small>
            <h1>{t("在应用内复现、标记并修复前端问题")}</h1>
            <p>{t("打开本地开发地址或线上页面，然后使用“标注页面”选择元素。Agent 将获得选择器、样式、无障碍信息和截图。")}</p>
            <div><span><i>01</i>{t("打开页面")}</span><span><i>02</i>{t("选择问题元素")}</span><span><i>03</i>{t("交给 Agent 修复")}</span></div>
          </section>
        )}
      </div>
    </main>
  );
}
