import type { AppearanceTheme } from "../src/contracts.js";

/* 标注浮层注入网页 Shadow DOM，自带配色（docs-internal/design-refresh-apple.md 3.2）。
   主题在 start() 时由调用方传入（BrowserService 注入时取当前主题）；
   标注会话中途切换主题不实时重绘，重新开始标注即按新主题渲染。 */
export const browserAnnotationBootstrap = String.raw`
(() => {
  if (globalThis.__PI_ANNOTATE_RUNTIME__) return;

  const STYLE_KEYS = [
    "display", "position", "zIndex", "flexDirection", "alignItems", "justifyContent",
    "gridTemplateColumns", "width", "height", "padding", "margin", "border",
    "borderRadius", "color", "backgroundColor", "fontFamily", "fontSize",
    "fontWeight", "lineHeight", "opacity", "overflow"
  ];

  const runtime = {
    active: false,
    finish: null,
    host: null,
    shadow: null,
    hoverBox: null,
    hoverTarget: null,
    selected: [],
    selectionBoxes: [],
    promptInput: null,

    start(initialPrompt, theme) {
      if (this.active) return Promise.reject(new Error("Annotation is already active"));
      this.active = true;
      this.selected = [];
      this.mount(initialPrompt || "", theme === "light" ? "light" : "dark");
      this.bind();
      this.refreshBoxes();
      return new Promise((resolve) => { this.finish = resolve; });
    },

    mount(initialPrompt, theme) {
      const host = document.createElement("div");
      host.id = "pi-desktop-annotate-host";
      if (theme === "light") host.className = "light";
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<style>' +
        ':host{color-scheme:dark;' +
          '--accent:#30d158;--accent-soft:rgba(48,209,88,.09);--accent-dim:rgba(48,209,88,.12);--accent-ring:rgba(48,209,88,.07);--accent-focus:rgba(48,209,88,.62);--accent-line:rgba(48,209,88,.28);--accent-hover:#4bdd77;--on-accent:#06130a;' +
          '--sel:#61a8ff;--sel-soft:rgba(97,168,255,.07);--sel-dim:rgba(97,168,255,.18);--sel-text:#79b7ff;--on-sel:#07101b;' +
          '--panel-bg:rgba(10,14,20,.96);--panel-shadow:0 8px 24px rgba(0,0,0,.32),0 0 0 1px rgba(255,255,255,.025);--hover-shadow:rgba(8,12,17,.72);' +
          '--text:#ecf4fb;--text-strong:#fff;--text-2:#8290a0;--text-3:#6f7c8a;--text-mono:#b9c7d5;--btn-text:#c9d4df;' +
          '--line:rgba(150,171,194,.14);--line-strong:rgba(150,171,194,.25);--line-input:rgba(150,171,194,.2);' +
          '--field-bg:#080c11;--note-bg:rgba(255,255,255,.025);--hover-fill:rgba(255,255,255,.07);--btn-bg:rgba(255,255,255,.035);--danger:#ff8585;--danger-soft:rgba(255,100,100,.1)}' +
        ':host(.light){color-scheme:light;' +
          '--accent:#1f7a36;--accent-soft:rgba(31,122,54,.08);--accent-dim:rgba(31,122,54,.1);--accent-glow:rgba(31,122,54,.14);--accent-ring:rgba(31,122,54,.12);--accent-focus:rgba(31,122,54,.55);--accent-line:rgba(31,122,54,.32);--accent-hover:#2b8a44;--on-accent:#fff;' +
          '--sel:#1f6feb;--sel-soft:rgba(31,111,235,.08);--sel-dim:rgba(31,111,235,.12);--sel-text:#1f6feb;--on-sel:#fff;' +
          '--panel-bg:rgba(255,255,255,.96);--panel-shadow:0 24px 80px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.02);--hover-shadow:rgba(255,255,255,.72);' +
          '--text:#1d1d1f;--text-strong:#000;--text-2:#6e6e73;--text-3:#8e8e93;--text-mono:#3a3a3c;--btn-text:#3a3a3c;' +
          '--line:rgba(0,0,0,.08);--line-strong:rgba(0,0,0,.12);--line-input:rgba(0,0,0,.14);' +
          '--field-bg:#fff;--note-bg:rgba(0,0,0,.02);--hover-fill:rgba(0,0,0,.05);--btn-bg:rgba(0,0,0,.03);--danger:#d70015;--danger-soft:rgba(215,0,21,.08)}' +
        '*{box-sizing:border-box}' +
        ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
        '.hover{position:fixed;border:2px solid var(--accent);background:var(--accent-soft);box-shadow:0 0 0 1px var(--hover-shadow);pointer-events:none;display:none}' +
        '.selected{position:fixed;border:2px solid var(--sel);background:var(--sel-soft);pointer-events:none}' +
        '.badge{position:absolute;left:-11px;top:-11px;width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:var(--sel);color:var(--on-sel);font:800 11px ui-monospace,SFMono-Regular,monospace;box-shadow:0 3px 14px rgba(0,0,0,.36)}' +
        '.panel{position:fixed;right:16px;top:16px;width:min(336px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;pointer-events:auto;overflow:hidden;border:1px solid var(--line-strong);border-radius:16px;background:var(--panel-bg);box-shadow:var(--panel-shadow);backdrop-filter:blur(18px);color:var(--text)}' +
        '.head{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid var(--line)}' +
        '.mark{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;background:var(--accent-dim);color:var(--accent);font:800 12px ui-monospace,SFMono-Regular,monospace}' +
        '.headcopy{min-width:0;flex:1}.head strong,.head small{display:block}.head strong{font-size:12px}.head small{margin-top:3px;color:var(--text-2);font-size:10px}' +
        '.close{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--text-2);cursor:pointer;font-size:18px}.close:hover{background:var(--hover-fill);color:var(--text-strong)}' +
        '.context{padding:11px 13px;border-bottom:1px solid var(--line)}' +
        '.context label{display:block;margin-bottom:6px;color:var(--text-2);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}' +
        '.context input,.note textarea{width:100%;border:1px solid var(--line-input);outline:0;border-radius:9px;background:var(--field-bg);color:var(--text);font:11px/1.45 Inter,-apple-system,sans-serif}' +
        '.context input{height:34px;padding:0 10px}.context input:focus,.note textarea:focus{border-color:var(--accent-focus);box-shadow:0 0 0 3px var(--accent-ring)}' +
        '.list{min-height:112px;overflow:auto;padding:10px 10px 2px}' +
        '.empty{padding:30px 18px;text-align:center;color:var(--text-2);font-size:11px;line-height:1.6}' +
        '.note{margin-bottom:8px;padding:9px;border:1px solid var(--line);border-radius:11px;background:var(--note-bg)}' +
        '.notehead{display:grid;grid-template-columns:22px minmax(0,1fr) 24px;align-items:center;gap:7px;margin-bottom:7px}' +
        '.num{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:var(--sel-dim);color:var(--sel-text);font:800 10px ui-monospace,SFMono-Regular,monospace}' +
        '.selector{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-mono);font:10px ui-monospace,SFMono-Regular,monospace;cursor:pointer}' +
        '.remove{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:var(--text-3);cursor:pointer}.remove:hover{background:var(--danger-soft);color:var(--danger)}' +
        '.note textarea{min-height:58px;resize:vertical;padding:8px 9px}' +
        '.foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;border-top:1px solid var(--line)}' +
        '.count{color:var(--text-2);font:10px ui-monospace,SFMono-Regular,monospace}' +
        '.actions{display:flex;gap:7px}.button{height:32px;padding:0 12px;border:1px solid var(--line-input);border-radius:9px;background:var(--btn-bg);color:var(--btn-text);font-size:10.5px;font-weight:700;cursor:pointer}.button:hover{background:var(--hover-fill)}' +
        '.button.primary{border-color:var(--accent-line);background:var(--accent);color:var(--on-accent)}.button.primary:hover{background:var(--accent-hover)}.button.primary:disabled{opacity:.4;cursor:not-allowed}' +
        '</style>' +
        '<div class="hover"></div>' +
        '<section class="panel" role="dialog" aria-label="Visual annotation">' +
          '<header class="head"><span class="mark">PI</span><span class="headcopy"><strong>Visual Debug</strong><small>Click elements to attach implementation notes</small></span><button class="close" aria-label="Cancel annotation">×</button></header>' +
          '<div class="context"><label for="pi-context">Debug context</label><input id="pi-context" maxlength="1000" placeholder="What should the agent fix?" /></div>' +
          '<div class="list"></div>' +
          '<footer class="foot"><span class="count">0 selected</span><span class="actions"><button class="button cancel">Cancel</button><button class="button primary submit" disabled>Send to Pi</button></span></footer>' +
        '</section>';
      document.documentElement.appendChild(host);
      this.host = host;
      this.shadow = shadow;
      this.hoverBox = shadow.querySelector(".hover");
      this.promptInput = shadow.querySelector("#pi-context");
      this.promptInput.value = initialPrompt;
      shadow.querySelector(".close").addEventListener("click", () => this.cancel("user"));
      shadow.querySelector(".cancel").addEventListener("click", () => this.cancel("user"));
      shadow.querySelector(".submit").addEventListener("click", () => this.submit());
      this.renderList();
    },

    bind() {
      this.onMove = (event) => {
        if (this.isOverlayEvent(event)) return this.hideHover();
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target === document.documentElement || target === document.body) return this.hideHover();
        this.hoverTarget = target;
        this.positionBox(this.hoverBox, target.getBoundingClientRect());
        this.hoverBox.style.display = "block";
      };
      this.onClick = (event) => {
        if (this.isOverlayEvent(event)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target === document.documentElement || target === document.body) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const existing = this.selected.findIndex((entry) => entry.element === target);
        if (existing >= 0) this.selected.splice(existing, 1);
        else if (this.selected.length < 20) this.selected.push({ element: target, comment: "" });
        this.renderList();
        this.refreshBoxes();
      };
      this.onKey = (event) => {
        if (event.key === "Escape") { event.preventDefault(); this.cancel("user"); }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); this.submit(); }
      };
      this.onViewport = () => this.refreshBoxes();
      document.addEventListener("pointermove", this.onMove, true);
      document.addEventListener("click", this.onClick, true);
      document.addEventListener("keydown", this.onKey, true);
      window.addEventListener("scroll", this.onViewport, true);
      window.addEventListener("resize", this.onViewport, true);
    },

    isOverlayEvent(event) {
      return event.composedPath().includes(this.host);
    },

    hideHover() {
      this.hoverTarget = null;
      if (this.hoverBox) this.hoverBox.style.display = "none";
    },

    positionBox(box, rect) {
      box.style.left = Math.round(rect.left) + "px";
      box.style.top = Math.round(rect.top) + "px";
      box.style.width = Math.max(0, Math.round(rect.width)) + "px";
      box.style.height = Math.max(0, Math.round(rect.height)) + "px";
    },

    refreshBoxes() {
      if (!this.shadow) return;
      for (const box of this.selectionBoxes) box.remove();
      this.selectionBoxes = [];
      this.selected.forEach((entry, index) => {
        if (!entry.element.isConnected) return;
        const box = document.createElement("div");
        box.className = "selected";
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(index + 1);
        box.appendChild(badge);
        this.shadow.appendChild(box);
        this.positionBox(box, entry.element.getBoundingClientRect());
        this.selectionBoxes.push(box);
      });
      if (this.hoverTarget && this.hoverTarget.isConnected) this.positionBox(this.hoverBox, this.hoverTarget.getBoundingClientRect());
    },

    renderList() {
      const list = this.shadow.querySelector(".list");
      const count = this.shadow.querySelector(".count");
      const submit = this.shadow.querySelector(".submit");
      count.textContent = this.selected.length + (this.selected.length === 1 ? " selected" : " selected");
      submit.disabled = this.selected.length === 0;
      list.replaceChildren();
      if (this.selected.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Hover the page and click an element. Select up to 20 targets.";
        list.appendChild(empty);
        return;
      }
      this.selected.forEach((entry, index) => {
        const card = document.createElement("article");
        card.className = "note";
        const head = document.createElement("div");
        head.className = "notehead";
        const num = document.createElement("span");
        num.className = "num";
        num.textContent = String(index + 1);
        const selector = document.createElement("button");
        selector.type = "button";
        selector.className = "selector";
        selector.textContent = this.selector(entry.element);
        selector.title = selector.textContent;
        selector.addEventListener("click", () => entry.element.scrollIntoView({ behavior: "smooth", block: "center" }));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", "Remove selection " + (index + 1));
        remove.addEventListener("click", () => { this.selected.splice(index, 1); this.renderList(); this.refreshBoxes(); });
        head.append(num, selector, remove);
        const textarea = document.createElement("textarea");
        textarea.maxLength = 2000;
        textarea.placeholder = "Describe the bug or expected result…";
        textarea.value = entry.comment;
        textarea.addEventListener("input", () => { entry.comment = textarea.value; });
        card.append(head, textarea);
        list.appendChild(card);
      });
    },

    selector(element) {
      if (element.id) {
        const idSelector = "#" + CSS.escape(element.id);
        try { if (document.querySelectorAll(idSelector).length === 1) return idSelector; } catch {}
      }
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        const stableClass = Array.from(current.classList).find((value) => value && value.length < 64 && !/^[a-f0-9]{8,}$/i.test(value));
        if (stableClass) part += "." + CSS.escape(stableClass);
        const parent = current.parentElement;
        if (parent) {
          const peers = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (peers.length > 1) part += ":nth-of-type(" + (peers.indexOf(current) + 1) + ")";
        }
        parts.unshift(part);
        const candidate = parts.join(" > ");
        try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch {}
        current = parent;
      }
      return parts.join(" > ");
    },

    inspect(entry, index) {
      const element = entry.element;
      const rect = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const attributes = {};
      Array.from(element.attributes).slice(0, 40).forEach((attribute) => {
        if (attribute.name !== "style") attributes[attribute.name] = String(attribute.value).slice(0, 500);
      });
      const styles = {};
      STYLE_KEYS.forEach((key) => { const value = computed[key]; if (value) styles[key] = String(value).slice(0, 300); });
      const implicitRole = { A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img" }[element.tagName];
      const role = element.getAttribute("role") || implicitRole || undefined;
      const name = element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300) || undefined;
      const focusable = element.matches("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])");
      const disabled = element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
      return {
        index: index + 1,
        tag: element.tagName.toLowerCase(),
        selector: this.selector(element),
        id: element.id || undefined,
        classes: Array.from(element.classList).slice(0, 20),
        text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 1000) || undefined,
        comment: entry.comment.trim().slice(0, 2000) || undefined,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        attributes,
        styles,
        accessibility: { role, name, focusable, disabled }
      };
    },

    submit() {
      if (!this.active || this.selected.length === 0) return;
      const result = {
        success: true,
        prompt: this.promptInput.value.trim().slice(0, 1000) || undefined,
        viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 },
        elements: this.selected.filter((entry) => entry.element.isConnected).map((entry, index) => this.inspect(entry, index))
      };
      this.complete(result);
    },

    cancel(reason) {
      if (!this.active) return;
      this.complete({
        success: false,
        cancelled: true,
        reason: reason || "user",
        viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 },
        elements: []
      });
    },

    complete(result) {
      const finish = this.finish;
      this.cleanup();
      if (finish) finish(result);
    },

    cleanup() {
      document.removeEventListener("pointermove", this.onMove, true);
      document.removeEventListener("click", this.onClick, true);
      document.removeEventListener("keydown", this.onKey, true);
      window.removeEventListener("scroll", this.onViewport, true);
      window.removeEventListener("resize", this.onViewport, true);
      if (this.host) this.host.remove();
      this.active = false;
      this.finish = null;
      this.host = null;
      this.shadow = null;
      this.hoverBox = null;
      this.hoverTarget = null;
      this.selected = [];
      this.selectionBoxes = [];
      this.promptInput = null;
    }
  };

  globalThis.__PI_ANNOTATE_RUNTIME__ = runtime;
  globalThis.__PI_ANNOTATE_CANCEL__ = () => runtime.cancel("cancelled");
})();
`;

export function startBrowserAnnotationScript(prompt = "", theme: AppearanceTheme = "dark"): string {
  return `globalThis.__PI_ANNOTATE_RUNTIME__.start(${JSON.stringify(prompt)}, ${JSON.stringify(theme)})`;
}

export const cancelBrowserAnnotationScript = "globalThis.__PI_ANNOTATE_CANCEL__?.()";
