import { randomUUID } from "node:crypto";
import { BrowserWindow, session, WebContentsView, type Session } from "electron";
import type {
  AppearanceTheme,
  BrowserAnnotationCapture,
  BrowserAnnotationElement,
  BrowserAnnotationResult,
  BrowserBounds,
  BrowserClearDataInput,
  BrowserEvent,
  BrowserMode,
  BrowserScreenshotMetadata,
  BrowserState,
} from "../src/contracts.js";
import {
  browserAnnotationBootstrap,
  cancelBrowserAnnotationScript,
  startBrowserAnnotationScript,
} from "./browser-annotation-script.js";
import { formatBrowserAnnotation, normalizeBrowserUrl } from "./browser-utils.js";
import { BrowserArtifactStore, type BrowserArtifactCleanupReport } from "./browser-artifact-store.js";

const annotationWorldId = 999;
const maxElements = 20;
const persistentPartition = "persist:pi-desktop-browser";

/* 原生 WebContentsView 背景随主题切换（docs-internal/design-refresh-apple.md 3.6），
   深色对齐 token v2 --bg-window，浅色对齐浅色 --bg-window。 */
const viewBackground: Record<AppearanceTheme, string> = { dark: "#1C1C1E", light: "#F5F5F7" };

type BrowserEventSink = (event: BrowserEvent) => void;

export type BrowserDebugPort = Pick<BrowserService, "startAnnotation">;

function text(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringRecord(value: unknown, maxEntries: number, maxValueLength: number): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, maxEntries)
    .flatMap(([key, entry]) => typeof entry === "string" ? [[key.slice(0, 100), entry.slice(0, maxValueLength)]] : []));
}

function annotationElement(value: unknown, index: number): BrowserAnnotationElement | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const tag = text(input.tag, 80);
  const selector = text(input.selector, 1_000);
  if (!tag || !selector) return undefined;
  const rect = input.rect && typeof input.rect === "object" ? input.rect as Record<string, unknown> : {};
  const accessibility = input.accessibility && typeof input.accessibility === "object"
    ? input.accessibility as Record<string, unknown>
    : {};
  return {
    index: index + 1,
    tag,
    selector,
    id: text(input.id, 300),
    classes: Array.isArray(input.classes)
      ? input.classes.flatMap((entry) => typeof entry === "string" ? [entry.slice(0, 200)] : []).slice(0, 20)
      : [],
    text: text(input.text, 1_000),
    comment: text(input.comment, 2_000),
    rect: {
      x: finite(rect.x),
      y: finite(rect.y),
      width: Math.max(0, finite(rect.width)),
      height: Math.max(0, finite(rect.height)),
    },
    attributes: stringRecord(input.attributes, 40, 500),
    styles: stringRecord(input.styles, 30, 300),
    accessibility: {
      role: text(accessibility.role, 100),
      name: text(accessibility.name, 300),
      focusable: accessibility.focusable === true,
      disabled: accessibility.disabled === true,
    },
  };
}

function parseAnnotation(value: unknown, url: string, title: string): BrowserAnnotationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      success: false,
      reason: "页面没有返回有效的标注数据。",
      url,
      title,
      viewport: { width: 0, height: 0, deviceScaleFactor: 1 },
      elements: [],
    };
  }
  const input = value as Record<string, unknown>;
  const viewport = input.viewport && typeof input.viewport === "object" ? input.viewport as Record<string, unknown> : {};
  const elements = Array.isArray(input.elements)
    ? input.elements.slice(0, maxElements).map(annotationElement).filter((entry): entry is BrowserAnnotationElement => Boolean(entry))
    : [];
  return {
    success: input.success === true,
    cancelled: input.cancelled === true || undefined,
    reason: text(input.reason, 500),
    url,
    title,
    prompt: text(input.prompt, 1_000),
    viewport: {
      width: Math.max(0, finite(viewport.width)),
      height: Math.max(0, finite(viewport.height)),
      deviceScaleFactor: Math.max(0.1, finite(viewport.deviceScaleFactor, 1)),
    },
    elements,
  };
}

export class BrowserService {
  private persistentView?: WebContentsView;
  private privateView?: WebContentsView;
  private privateSession?: Session;
  private privatePartition?: string;
  private readonly privateSessions = new Set<Session>();
  private readonly configuredSessions = new WeakSet<Session>();
  private readonly artifacts: BrowserArtifactStore;
  private visible = false;
  private annotating = false;
  private error?: string;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 1, height: 1 };
  private theme: AppearanceTheme = "dark";
  private mode: BrowserMode = "persistent";

  constructor(
    private readonly window: () => BrowserWindow | null,
    artifactDirectory: string,
    private readonly emit: BrowserEventSink,
    artifactStore?: BrowserArtifactStore,
  ) {
    this.artifacts = artifactStore ?? new BrowserArtifactStore(artifactDirectory);
  }

  state(): BrowserState {
    const contents = this.activeView()?.webContents;
    return {
      url: contents?.getURL() ?? "about:blank",
      title: contents?.getTitle() ?? "",
      loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      visible: this.visible,
      annotating: this.annotating,
      mode: this.mode,
      error: this.error,
    };
  }

  cleanupArtifacts(): Promise<BrowserArtifactCleanupReport> {
    return this.artifacts.cleanup();
  }

  async navigate(input: string): Promise<BrowserState> {
    const view = this.ensureView();
    const url = normalizeBrowserUrl(input);
    this.error = undefined;
    if (url === "about:blank") {
      await view.webContents.loadURL(url);
    } else {
      view.setVisible(this.visible);
      await view.webContents.loadURL(url);
    }
    this.publish();
    return this.state();
  }

  back(): BrowserState {
    const contents = this.ensureView().webContents;
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    this.publish();
    return this.state();
  }

  forward(): BrowserState {
    const contents = this.ensureView().webContents;
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    this.publish();
    return this.state();
  }

  reload(): BrowserState {
    this.ensureView().webContents.reload();
    this.publish();
    return this.state();
  }

  stop(): BrowserState {
    this.ensureView().webContents.stop();
    this.publish();
    return this.state();
  }

  async setMode(mode: BrowserMode): Promise<BrowserState> {
    if (mode === this.mode) return this.state();
    if (this.annotating) throw new Error("页面标注期间不能切换浏览模式。");
    const previousMode = this.mode;
    this.error = undefined;
    if (previousMode === "private") await this.destroyPrivateSession();
    else this.persistentView?.setVisible(false);
    this.mode = mode;
    if (this.visible) this.ensureView();
    this.publish();
    return this.state();
  }

  async clearData(input: BrowserClearDataInput): Promise<BrowserState> {
    if (this.annotating && input.mode === this.mode) throw new Error("页面标注期间不能清理浏览数据。");
    const browserSession = input.mode === "persistent"
      ? session.fromPartition(persistentPartition)
      : this.privateSession;
    if (!browserSession) return this.state();

    const dataTypes = new Set(input.dataTypes);
    const view = this.viewFor(input.mode);
    const restoreUrl = view?.webContents.isDestroyed() ? undefined : view?.webContents.getURL();
    // Session.clearStorageData clears localStorage for every origin in the partition.
    // Closing the target WebContents also destroys its per-tab sessionStorage namespace.
    if (dataTypes.has("storage")) this.destroyView(input.mode);
    if (dataTypes.has("cookies")) await browserSession.clearStorageData({ storages: ["cookies"] });
    if (dataTypes.has("cache")) await browserSession.clearCache();
    if (dataTypes.has("storage")) await browserSession.clearStorageData({ storages: ["localstorage"] });
    if (dataTypes.has("storage") && input.mode === this.mode && this.visible) {
      const next = this.ensureView();
      if (restoreUrl && restoreUrl !== "about:blank") await next.webContents.loadURL(restoreUrl);
    }
    this.publish();
    return this.state();
  }

  setBounds(value: BrowserBounds): void {
    const parent = this.window();
    if (!parent || parent.isDestroyed()) return;
    const windowBounds = parent.getContentBounds();
    const x = Math.max(0, Math.min(windowBounds.width - 1, Math.round(finite(value.x))));
    const y = Math.max(0, Math.min(windowBounds.height - 1, Math.round(finite(value.y))));
    this.bounds = {
      x,
      y,
      width: Math.max(1, Math.min(windowBounds.width - x, Math.round(finite(value.width, 1)))),
      height: Math.max(1, Math.min(windowBounds.height - y, Math.round(finite(value.height, 1)))),
    };
    this.activeView()?.setBounds(this.bounds);
  }

  async setVisible(visible: boolean): Promise<BrowserState> {
    if (!visible && this.annotating) await this.cancelAnnotation();
    this.visible = visible;
    if (visible) {
      const view = this.ensureView();
      view.setBounds(this.bounds);
    } else if (this.mode === "private") {
      await this.destroyPrivateSession();
    }
    this.syncViewVisibility();
    this.publish();
    return this.state();
  }

  /** 主题同步：记录主题并应用到已存在的原生视图；视图延迟创建时在 ensureView 里取当前主题。 */
  setTheme(theme: AppearanceTheme): void {
    this.theme = theme;
    this.persistentView?.setBackgroundColor(viewBackground[theme]);
    this.privateView?.setBackgroundColor(viewBackground[theme]);
  }

  async startAnnotation(url?: string, prompt = "", signal?: AbortSignal, owner = "agent-runtime"): Promise<BrowserAnnotationCapture> {
    if (this.annotating) throw new Error("已经有一个页面标注任务正在进行。");
    const view = this.ensureView();
    if (url) await this.navigate(url);
    if (!view.webContents.getURL() || view.webContents.getURL() === "about:blank") {
      throw new Error("请先在内置浏览器中打开要调试的页面。");
    }
    if (view.webContents.isLoading()) await this.waitForLoad(view);

    this.annotating = true;
    this.error = undefined;
    this.publish();
    const onAbort = () => { void this.cancelAnnotation(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await view.webContents.executeJavaScriptInIsolatedWorld(annotationWorldId, [{ code: browserAnnotationBootstrap }], true);
      const raw = await view.webContents.executeJavaScriptInIsolatedWorld(
        annotationWorldId,
        [{ code: startBrowserAnnotationScript(prompt, this.theme) }],
        true,
      );
      const result = parseAnnotation(raw, view.webContents.getURL(), view.webContents.getTitle());
      if (result.success) {
        result.screenshot = await this.captureScreenshot(view, owner);
        result.screenshotPath = result.screenshot.path;
      }
      return { result, markdown: formatBrowserAnnotation(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: BrowserAnnotationResult = {
        success: false,
        cancelled: signal?.aborted || undefined,
        reason: signal?.aborted ? "aborted" : message,
        url: view.webContents.isDestroyed() ? "" : view.webContents.getURL(),
        title: view.webContents.isDestroyed() ? "" : view.webContents.getTitle(),
        viewport: { width: 0, height: 0, deviceScaleFactor: 1 },
        elements: [],
      };
      return { result, markdown: formatBrowserAnnotation(result) };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.annotating = false;
      this.publish();
    }
  }

  async cancelAnnotation(): Promise<void> {
    const view = this.activeView();
    if (!view || view.webContents.isDestroyed() || !this.annotating) return;
    await view.webContents.executeJavaScriptInIsolatedWorld(
      annotationWorldId,
      [{ code: cancelBrowserAnnotationScript }],
      true,
    ).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.destroyView("persistent");
    await this.destroyPrivateSession();
  }

  private ensureView(): WebContentsView {
    const existing = this.activeView();
    if (existing && !existing.webContents.isDestroyed()) return existing;
    const parent = this.window();
    if (!parent || parent.isDestroyed()) throw new Error("主窗口尚未准备好。");
    const partition = this.mode === "persistent"
      ? persistentPartition
      : this.privatePartition ?? `pi-desktop-private-${randomUUID()}`;
    const browserSession = session.fromPartition(partition);
    if (this.mode === "private") {
      this.privatePartition = partition;
      this.privateSession = browserSession;
      this.privateSessions.add(browserSession);
    }
    this.configureSession(browserSession);

    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setBackgroundColor(viewBackground[this.theme]);
    view.setBounds(this.bounds);
    view.setVisible(false);
    parent.contentView.addChildView(view);

    const publish = () => this.publish();
    view.webContents.on("did-start-loading", publish);
    view.webContents.on("did-stop-loading", publish);
    view.webContents.on("did-navigate", publish);
    view.webContents.on("did-navigate-in-page", publish);
    view.webContents.on("page-title-updated", publish);
    view.webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.error = `${description} (${code}) · ${validatedUrl}`;
      this.publish();
    });
    view.webContents.on("will-attach-webview", (event) => event.preventDefault());
    view.webContents.on("will-navigate", (event, target) => {
      try {
        normalizeBrowserUrl(target);
      } catch {
        event.preventDefault();
      }
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        void view.webContents.loadURL(normalizeBrowserUrl(url));
      } catch {
        this.error = "已阻止页面打开不受支持的外部协议。";
        this.publish();
      }
      return { action: "deny" };
    });
    if (this.mode === "persistent") this.persistentView = view;
    else this.privateView = view;
    void view.webContents.loadURL("about:blank");
    return view;
  }

  private activeView(): WebContentsView | undefined {
    return this.viewFor(this.mode);
  }

  private viewFor(mode: BrowserMode): WebContentsView | undefined {
    return mode === "persistent" ? this.persistentView : this.privateView;
  }

  private configureSession(browserSession: Session): void {
    if (this.configuredSessions.has(browserSession)) return;
    this.configuredSessions.add(browserSession);
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.on("will-download", (event) => event.preventDefault());
  }

  private destroyView(mode: BrowserMode): void {
    const view = this.viewFor(mode);
    if (!view) return;
    const parent = this.window();
    if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (mode === "persistent") this.persistentView = undefined;
    else this.privateView = undefined;
  }

  private async destroyPrivateSession(): Promise<void> {
    this.destroyView("private");
    this.privateSession = undefined;
    this.privatePartition = undefined;
    const failures: unknown[] = [];
    for (const browserSession of this.privateSessions) {
      const results = await Promise.allSettled([
        browserSession.clearStorageData(),
        browserSession.clearCache(),
        browserSession.closeAllConnections(),
      ]);
      const sessionFailures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (sessionFailures.length === 0) this.privateSessions.delete(browserSession);
      else failures.push(...sessionFailures);
    }
    if (failures.length > 0) throw new AggregateError(failures, "隐私浏览数据清理失败。");
  }

  private publish(): void {
    this.syncViewVisibility();
    this.emit({ type: "state", state: this.state() });
  }

  private syncViewVisibility(): void {
    this.persistentView?.setVisible(false);
    this.privateView?.setVisible(false);
    const view = this.activeView();
    if (!view || view.webContents.isDestroyed()) return;
    const url = view.webContents.getURL();
    view.setVisible(this.visible && Boolean(url) && url !== "about:blank");
  }

  private waitForLoad(view: WebContentsView): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => done(new Error("等待页面加载超时。")), 30_000);
      const stopped = () => done();
      const failed = (_event: Electron.Event, code: number, description: string, _url: string, isMainFrame: boolean) => {
        if (isMainFrame && code !== -3) done(new Error(`${description} (${code})`));
      };
      const done = (error?: Error) => {
        clearTimeout(timeout);
        view.webContents.removeListener("did-stop-loading", stopped);
        view.webContents.removeListener("did-fail-load", failed);
        if (error) reject(error); else resolve();
      };
      view.webContents.once("did-stop-loading", stopped);
      view.webContents.on("did-fail-load", failed);
    });
  }

  private async captureScreenshot(view: WebContentsView, owner: string): Promise<BrowserScreenshotMetadata> {
    const image = await view.webContents.capturePage();
    return this.artifacts.save(image.toPNG(), owner);
  }
}
