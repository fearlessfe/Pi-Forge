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

    start(initialPrompt) {
      if (this.active) return Promise.reject(new Error("Annotation is already active"));
      this.active = true;
      this.selected = [];
      this.mount(initialPrompt || "");
      this.bind();
      this.refreshBoxes();
      return new Promise((resolve) => { this.finish = resolve; });
    },

    mount(initialPrompt) {
      const host = document.createElement("div");
      host.id = "pi-desktop-annotate-host";
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<style>' +
        ':host{color-scheme:dark}' +
        '*{box-sizing:border-box}' +
        '.hover{position:fixed;border:2px solid #7bf1a8;background:rgba(123,241,168,.09);box-shadow:0 0 0 1px rgba(8,12,17,.72),0 0 26px rgba(123,241,168,.15);pointer-events:none;display:none}' +
        '.selected{position:fixed;border:2px solid #61a8ff;background:rgba(97,168,255,.07);pointer-events:none}' +
        '.badge{position:absolute;left:-11px;top:-11px;width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:#61a8ff;color:#07101b;font:800 11px ui-monospace,SFMono-Regular,monospace;box-shadow:0 3px 14px rgba(0,0,0,.36)}' +
        '.panel{position:fixed;right:16px;top:16px;width:min(336px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;pointer-events:auto;overflow:hidden;border:1px solid rgba(150,171,194,.25);border-radius:16px;background:rgba(10,14,20,.96);box-shadow:0 24px 80px rgba(0,0,0,.46),0 0 0 1px rgba(255,255,255,.025);backdrop-filter:blur(18px);color:#ecf4fb}' +
        '.head{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid rgba(150,171,194,.14)}' +
        '.mark{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;background:rgba(123,241,168,.12);color:#7bf1a8;font:800 12px ui-monospace,SFMono-Regular,monospace}' +
        '.headcopy{min-width:0;flex:1}.head strong,.head small{display:block}.head strong{font-size:12px}.head small{margin-top:3px;color:#8290a0;font-size:10px}' +
        '.close{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#8290a0;cursor:pointer;font-size:18px}.close:hover{background:rgba(255,255,255,.07);color:#fff}' +
        '.context{padding:11px 13px;border-bottom:1px solid rgba(150,171,194,.12)}' +
        '.context label{display:block;margin-bottom:6px;color:#8290a0;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}' +
        '.context input,.note textarea{width:100%;border:1px solid rgba(150,171,194,.2);outline:0;border-radius:9px;background:#080c11;color:#ecf4fb;font:11px/1.45 Inter,-apple-system,sans-serif}' +
        '.context input{height:34px;padding:0 10px}.context input:focus,.note textarea:focus{border-color:rgba(123,241,168,.62);box-shadow:0 0 0 3px rgba(123,241,168,.07)}' +
        '.list{min-height:112px;overflow:auto;padding:10px 10px 2px}' +
        '.empty{padding:30px 18px;text-align:center;color:#8290a0;font-size:11px;line-height:1.6}' +
        '.note{margin-bottom:8px;padding:9px;border:1px solid rgba(150,171,194,.15);border-radius:11px;background:rgba(255,255,255,.025)}' +
        '.notehead{display:grid;grid-template-columns:22px minmax(0,1fr) 24px;align-items:center;gap:7px;margin-bottom:7px}' +
        '.num{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:rgba(97,168,255,.18);color:#79b7ff;font:800 10px ui-monospace,SFMono-Regular,monospace}' +
        '.selector{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9c7d5;font:10px ui-monospace,SFMono-Regular,monospace;cursor:pointer}' +
        '.remove{width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:#6f7c8a;cursor:pointer}.remove:hover{background:rgba(255,100,100,.1);color:#ff8585}' +
        '.note textarea{min-height:58px;resize:vertical;padding:8px 9px}' +
        '.foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;border-top:1px solid rgba(150,171,194,.14)}' +
        '.count{color:#8290a0;font:10px ui-monospace,SFMono-Regular,monospace}' +
        '.actions{display:flex;gap:7px}.button{height:32px;padding:0 12px;border:1px solid rgba(150,171,194,.2);border-radius:9px;background:rgba(255,255,255,.035);color:#c9d4df;font-size:10.5px;font-weight:700;cursor:pointer}.button:hover{background:rgba(255,255,255,.07)}' +
        '.button.primary{border-color:rgba(123,241,168,.28);background:#7bf1a8;color:#07110b}.button.primary:hover{background:#91f5b5}.button.primary:disabled{opacity:.4;cursor:not-allowed}' +
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

export function startBrowserAnnotationScript(prompt = ""): string {
  return `globalThis.__PI_ANNOTATE_RUNTIME__.start(${JSON.stringify(prompt)})`;
}

export const cancelBrowserAnnotationScript = "globalThis.__PI_ANNOTATE_CANCEL__?.()";
