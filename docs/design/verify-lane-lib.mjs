/**
 * 验收车道共享库：Vite dev server 引导 + window.piDesktop mock + 场景/主题断言。
 * 被 verify-renderer-lane.mjs 与 verify-a11y.mjs 共同引用，保证 mock 只有一份。
 *
 * 维护要求：installMockBridge 的 mock 必须与 apps/desktop/src/contracts.ts 的
 * PiDesktopApi 同步——契约增改方法/返回类型时同步更新本 mock；凡契约要求返回
 * 对象的方法，mock 不得返回 null/undefined，须给出最小合法形状。
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

// 必须在 require playwright 之前设置：浏览器二进制装在 workspace 的 node_modules 内。
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
export const { chromium } = require("playwright");

export const repoRoot = path.resolve(import.meta.dirname, "../..");
const rendererDir = path.join(repoRoot, "apps/desktop");
export const PORT = Number.parseInt(process.env.PI_DESKTOP_VERIFY_PORT ?? "4173", 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error(`PI_DESKTOP_VERIFY_PORT 必须是有效 TCP 端口，实际 ${JSON.stringify(process.env.PI_DESKTOP_VERIFY_PORT)}。`);
}
export const BASE_URL = `http://127.0.0.1:${PORT}`;
// 本项目 dev server 的特征：index.html 通过 <script src="/src/main.tsx"> 挂载入口。
const SERVER_SIGNATURE = "src/main.tsx";

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.end(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs, serverProcess) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`Vite dev server 提前退出（exit ${serverProcess.exitCode}）。`);
    if (await isPortOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 127.0.0.1:${port} 就绪超时。`);
}

/** 复用前先确认端口上的服务确实是本项目的 Vite dev server，不静默复用别的 checkout。 */
async function assertServerIdentity() {
  let html;
  try {
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(5_000) });
    html = await response.text();
  } catch (err) {
    throw new Error(`127.0.0.1:${PORT} 在监听但无法读取首页（${err.message}）。请确认占用进程后重试。`);
  }
  if (!html.includes(SERVER_SIGNATURE)) {
    throw new Error(
      `127.0.0.1:${PORT} 已被占用，但响应缺少本项目特征（${SERVER_SIGNATURE}），疑似其他服务。`
      + "请先停止占用该端口的进程，或由其释放端口后重试。",
    );
  }
}

export async function ensureDevServer() {
  if (await isPortOpen(PORT)) {
    await assertServerIdentity();
    console.log(`[lane] 127.0.0.1:${PORT} 已在监听且确认为本项目 dev server，复用。`);
    return null;
  }
  console.log("[lane] 启动 Vite dev server…");
  // detached：独立进程组，清理时按进程组杀（覆盖 vite 子进程）。
  const serverProcess = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
    cwd: rendererDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
  await waitForPort(PORT, 60_000, serverProcess);
  await assertServerIdentity();
  return serverProcess;
}

/** 按进程组 SIGTERM 杀掉 dev server 并等待退出，超时兜底 SIGKILL。 */
export function killServer(serverProcess) {
  return new Promise((resolve) => {
    if (!serverProcess || serverProcess.exitCode !== null) return resolve();
    const force = setTimeout(() => {
      try { process.kill(-serverProcess.pid, "SIGKILL"); } catch { /* 已退出 */ }
    }, 5_000);
    serverProcess.once("exit", () => { clearTimeout(force); resolve(); });
    try {
      process.kill(-serverProcess.pid, "SIGTERM");
    } catch {
      clearTimeout(force);
      resolve();
    }
  });
}

/** 安装 SIGINT/SIGTERM 清理钩子，返回当前 serverProcess 的取值函数。 */
export function installSignalHandlers(getServerProcess) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await killServer(getServerProcess());
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** 注入 window.piDesktop mock，形状对齐 apps/desktop/src/contracts.ts 的 PiDesktopApi（见文件头维护要求）。 */
export function installMockBridge(options = {}) {
  const now = new Date().toISOString();
  const modelSettings = {
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-6",
    thinkingLevel: "medium",
    hasApiKey: false,
    configuredProviders: [],
    credentials: [],
  };
  const catalog = [
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      kind: "builtin",
      supportsApiKey: true,
      supportsOAuth: true,
      oauthName: "Claude",
      models: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, contextWindow: 200000, maxOutputTokens: 64000 },
        { id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true, contextWindow: 200000, maxOutputTokens: 64000 },
      ],
    },
    {
      id: "openai-compatible",
      name: "OpenAI 兼容端点",
      baseUrl: "https://example.com/v1",
      kind: "compatible",
      supportsApiKey: true,
      supportsOAuth: false,
      models: [
        { id: "demo-model", name: "Demo Model", reasoning: false, contextWindow: 128000 },
      ],
    },
  ];
  const demoPluginPackage = {
    name: "@pi/demo-skills",
    version: "0.2.1",
    description: "演示用技能包：为 Agent 提供验收辅助技能。",
    publisher: "pi",
    license: "MIT",
    weeklyDownloads: 1234,
    insecure: false,
    resources: ["skills"],
    manifest: { skills: ["skills/demo"] },
    provenance: "npm-registry",
    riskTier: "low",
    compatibility: "desktop",
  };
  const pluginRuntime = {
    hasSession: false,
    configuredSubagent: { kind: "builtin" },
    effectiveSubagent: { kind: "builtin" },
    configuredMemory: { kind: "none" },
    effectiveMemory: { kind: "none" },
    configuredLearning: { kind: "none" },
    effectiveLearning: { kind: "none" },
    subagentHistory: [],
    memoryHistory: [],
    learningHistory: [],
    tools: [],
  };
  const demoConversation = {
    id: "conv-demo-1",
    title: "排查验收车道截图脚本",
    cwd: "/Users/demo/pi-desktop",
    createdAt: now,
    updatedAt: now,
    tags: ["验收"],
    archived: false,
    searchText: "排查验收车道截图脚本 console error",
  };
  const demoConversationDetail = {
    ...demoConversation,
    turns: [
      {
        id: "turn-1",
        question: "截图脚本启动后白屏，可能是什么原因？",
        answer: [
          "## 排查结论",
          "",
          "白屏通常来自 bridge 未就绪：渲染层在 mount 时会立即调用 `settings.get()`、`agent.listConversations()` 等接口。",
          "",
          "- 确认 `window.piDesktop` 在应用脚本之前注入",
          "- mock 的所有方法必须返回 Promise",
          "- `onEvent` 必须返回退订函数，否则 StrictMode 第二次挂载会抛错",
        ].join("\n"),
        activities: [],
      },
      {
        id: "turn-2",
        question: "插件中心为什么单独报错？",
        answer: [
          "`PluginsPanel` 用非可选链访问 `window.piDesktop.plugins.*`，所以 mock 必须提供完整的 plugins 命名空间：",
          "",
          "```ts",
          'await window.piDesktop.plugins.list(workspaceCwd);',
          'await window.piDesktop.plugins.runtime();',
          "```",
          "",
          "缺任何一个方法都会在 mount 阶段抛出 `TypeError`。",
        ].join("\n"),
        activities: [],
      },
    ],
  };
  const demoConversationProfile = {
    version: 1,
    conversationId: demoConversation.id,
    provider: modelSettings.provider,
    baseUrl: modelSettings.baseUrl,
    modelId: modelSettings.modelId,
    thinkingLevel: modelSettings.thinkingLevel,
    cwd: demoConversation.cwd,
    resourceSelectionMode: "inherit",
    selectedSkills: [],
    selectedMcpServers: [],
    updatedAt: now,
  };
  const performanceMarkdownPrefix = [
    "## PERF-01 long response fixture",
    "",
    "| Column | Status | Notes |",
    "| --- | --- | --- |",
    "| viewport | stable | anchor retained |",
    "| streaming | batched | within 60ms budget |",
    "",
    "```ts",
    "export const fixture = { turns: 100, virtualized: true };",
    "```",
    "",
  ].join("\n");
  const performanceMessage = (performanceMarkdownPrefix + "fixture content ".repeat(4_000)).slice(0, 50_000);
  const performanceTurns = Array.from({ length: 100 }, (_, index) => {
    const isLast = index === 99;
    return {
      id: `perf-turn-${index}`,
      sessionEntryId: `perf-entry-${index}`,
      question: `PERF-01 question ${index}`,
      answer: "",
      activities: isLast
        ? [
            ...Array.from({ length: 20 }, (__, toolIndex) => ({
              id: `perf-tool-${toolIndex}`,
              type: "tool",
              name: toolIndex % 2 === 0 ? "read" : "bash",
              args: { command: `fixture-${toolIndex}` },
              output: `fixture output ${toolIndex}`,
              status: "success",
            })),
            { id: "perf-message", type: "message", text: performanceMessage },
          ]
        : [{ id: `perf-message-${index}`, type: "message", text: `PERF-01 response ${index}` }],
      status: "completed",
    };
  });
  const conversationDetail = options.performanceConversation
    ? { ...demoConversationDetail, turns: performanceTurns }
    : demoConversationDetail;
  const browserState = {
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    visible: false,
    annotating: false,
  };
  const trust = { path: "/Users/demo/pi-desktop", trusted: true, hasProjectResources: false, resourcePaths: [] };
  const resourceSettings = { workspaceContextEnabled: true, disabledSkills: [] };
  const resourceInventory = {
    cwd: trust.path,
    settings: resourceSettings,
    trust,
    skills: [],
    diagnostics: [],
    commands: [],
  };
  const contextBudget = {
    cwd: trust.path,
    estimator: { id: "gpt-tokenizer-o200k-v1", kind: "model-tokenizer", provider: "openai", model: "gpt-5", tokenizer: "o200k_base", local: true },
    baselineEstimatedTokens: 1640,
    onDemandEstimatedTokens: 760,
    totalEstimatedTokens: 2400,
    availableEstimatedTokens: 2400,
    estimatedSavingsTokens: 620,
    history: [{ id: "snapshot-1", cwd: trust.path, conversationId: "conv-demo-1", runId: "run-demo-1", createdAt: now, provider: "openai", model: "gpt-5", estimatorId: "gpt-tokenizer-o200k-v1", estimatedResourceTokens: 2400, actualInputTokens: 10400, actualContextTokens: 11800, deltaTokens: 9400, estimatedSharePercent: 20.34 }],
    groups: [{
      category: "skills",
      enabledItems: 1,
      totalItems: 1,
      baselineEstimatedTokens: 620,
      onDemandEstimatedTokens: 760,
      estimatedTokens: 1380,
      availableEstimatedTokens: 1380,
      estimatedSavingsTokens: 620,
      items: [{
        id: "skills:user:code-review",
        category: "skills",
        name: "code-review",
        source: "user",
        scope: "user",
        enabled: true,
        disableSupported: true,
        loadMode: "mixed",
        estimateStatus: "estimated",
        baselineEstimatedTokens: 620,
        onDemandEstimatedTokens: 760,
        estimatedTokens: 1380,
        estimatedSavingsTokens: 620,
      }],
    }],
  };
  const terminalSession = {
    id: "mock-terminal-1",
    cwd: trust.path,
    shell: "/bin/zsh",
    title: "zsh",
    status: "running",
    cols: 80,
    rows: 24,
  };
  const resolve = (value) => () => Promise.resolve(value);
  const noop = () => () => {};
  const agentEventListeners = new Set();

  // Playwright-only hook. The production renderer never defines or reads it; the
  // lane uses it to exercise the same subscribed event path as Electron IPC.
  window.piVerify = {
    emitAgentEvent(event) {
      for (const listener of agentEventListeners) listener(event);
    },
    fixture: options.performanceConversation
      ? { turns: performanceTurns.length, lastMessageCharacters: performanceMessage.length, toolActivities: 20 }
      : undefined,
  };

  window.piDesktop = {
    updates: {
      state: resolve({ status: "unsupported", currentVersion: "0.1.0" }),
      check: resolve({ status: "unsupported", currentVersion: "0.1.0" }),
      download: resolve({ status: "unsupported", currentVersion: "0.1.0" }),
      install: resolve({ status: "unsupported", currentVersion: "0.1.0" }),
      onEvent: noop,
    },
    appearance: {
      nativeMaterial: false,
      setTheme: (_preference, resolvedTheme) => Promise.resolve(resolvedTheme),
    },
    settings: {
      get: resolve(modelSettings),
      catalog: resolve(catalog),
      refreshMetadata: resolve(catalog),
      saveMetadata: resolve(catalog),
      resetMetadata: resolve(catalog),
      discoverModels: resolve([]),
      save: resolve(modelSettings),
      test: resolve({ ok: true, response: "ok" }),
    },
    permissions: {
      get: resolve({ mode: "balanced", sandbox: "unavailable", platform: "darwin" }),
      save: resolve({ mode: "balanced", sandbox: "unavailable", platform: "darwin" }),
    },
    systemPrompt: {
      get: resolve({ content: "" }),
      save: resolve({ content: "" }),
    },
    observability: {
      get: resolve({ enabled: false, serviceName: "pi-desktop", captureContent: "none", localFileEnabled: false, exporters: [] }),
      save: resolve({ enabled: false, serviceName: "pi-desktop", captureContent: "none", localFileEnabled: false, exporters: [] }),
      status: resolve({ enabled: false, queuedSpanCount: 0 }),
      flush: resolve({ enabled: false, queuedSpanCount: 0 }),
    },
    auth: {
      login: resolve({ loginId: "mock-login" }),
      answer: resolve(undefined),
      cancel: resolve(undefined),
      logout: resolve(undefined),
      onEvent: noop,
    },
    workspace: {
      // 契约允许 choose() 返回 null（用户取消选择）。
      choose: resolve(null),
      trustStatus: resolve(trust),
      setTrusted: resolve(trust),
    },
    resources: {
      getSettings: resolve(resourceSettings),
      saveSettings: resolve(resourceSettings),
      inventory: resolve(resourceInventory),
      contextBudget: resolve(contextBudget),
      setSkillEnabled: resolve(resourceInventory),
      executeExtensionCommand: resolve({ handled: false }),
    },
    mcp: {
      overview: resolve({ servers: [], runtimes: [], logs: [] }),
      save: resolve({ servers: [], runtimes: [], logs: [] }),
      remove: resolve({ servers: [], runtimes: [], logs: [] }),
      connect: resolve({ servers: [], runtimes: [], logs: [] }),
      disconnect: resolve({ servers: [], runtimes: [], logs: [] }),
      reconnect: resolve({ servers: [], runtimes: [], logs: [] }),
    },
    terminal: {
      create: resolve(terminalSession),
      list: resolve([terminalSession]),
      write: resolve(undefined),
      resize: resolve(undefined),
      kill: resolve(undefined),
      onEvent: noop,
    },
    browser: {
      state: resolve(browserState),
      navigate: resolve(browserState),
      back: resolve(browserState),
      forward: resolve(browserState),
      reload: resolve(browserState),
      stop: resolve(browserState),
      setBounds: resolve(undefined),
      setVisible: resolve(browserState),
      startAnnotation: () => Promise.reject(new Error("mock: 不支持标注")),
      cancelAnnotation: resolve(undefined),
      onEvent: noop,
    },
    plugins: {
      search: resolve({ packages: [demoPluginPackage], total: 1, offset: 0 }),
      details: resolve(demoPluginPackage),
      list: resolve([
        {
          source: "npm:@pi/demo-skills",
          name: "@pi/demo-skills",
          version: "0.2.1",
          installed: true,
          enabled: true,
          publisher: "pi",
          provenance: "npm-registry",
          riskTier: "low",
          resources: ["skills"],
          verification: "verified",
        },
      ]),
      install: resolve({ installed: [], reloaded: false, runtime: pluginRuntime }),
      remove: resolve({ installed: [], reloaded: false, runtime: pluginRuntime }),
      reload: resolve({ reloaded: false, runtime: pluginRuntime }),
      setEnabled: resolve({ installed: [], reloaded: false, runtime: pluginRuntime }),
      runtime: resolve(pluginRuntime),
      setSubagentProvider: resolve(pluginRuntime),
      setPackageCapability: resolve(pluginRuntime),
      onEvent: noop,
    },
    agent: {
      send: resolve({ runId: "mock-run" }),
      listConversations: resolve([demoConversation]),
      listConversationPage: resolve({ items: [demoConversation], nextCursor: undefined }),
      loadConversation: resolve(conversationDetail),
      getProfile: resolve(demoConversationProfile),
      saveProfile: resolve(demoConversationProfile),
      renameConversation: resolve(undefined),
      forkConversation: resolve(demoConversation),
      exportConversation: resolve({ filename: "demo.md", mimeType: "text/markdown", content: "" }),
      setConversationArchived: resolve(undefined),
      setConversationTags: resolve(undefined),
      deleteConversation: resolve(undefined),
      abort: resolve(undefined),
      queue: resolve({ steering: [], followUp: [] }),
      clearQueue: resolve({ steering: [], followUp: [] }),
      listChanges: resolve([]),
      acceptChanges: resolve([]),
      revertChanges: resolve([]),
      openChange: resolve(undefined),
      revealChange: resolve(undefined),
      reset: resolve(undefined),
      answerQuestion: resolve(undefined),
      listPlanReviews: resolve([]),
      resolvePlanReview: resolve(undefined),
      listRecoveries: resolve([]),
      retryRecovery: resolve({ runId: "mock-run" }),
      discardRecovery: resolve(undefined),
      retryRuntime: resolve(undefined),
      listSubagents: resolve([]),
      pauseSubagent: resolve(undefined),
      resumeSubagent: resolve(undefined),
      retrySubagent: resolve(undefined),
      stopSubagent: resolve(undefined),
      prepareSubagentHandoff: resolve(""),
      onEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => agentEventListeners.delete(listener);
      },
    },
  };
}

export const scenarios = [
  {
    name: "new-chat",
    run: async (page) => {
      await page.getByRole("heading", { name: "今天想一起做什么？" }).waitFor();
    },
  },
  {
    name: "active-chat",
    run: async (page) => {
      await page.getByRole("heading", { name: "今天想一起做什么？" }).waitFor();
      await page.locator(".material-sidebar").getByRole("button", { name: /^排查验收车道截图脚本/ }).click();
      await page.getByText("排查结论").waitFor();
    },
  },
  {
    name: "settings",
    run: async (page) => {
      await page.getByRole("button", { name: /Pi 用户/ }).click();
      await page.getByRole("menuitem", { name: /^设置/ }).click();
      await page.getByRole("heading", { name: "大模型" }).waitFor();
      if (await page.locator(".material-sidebar").count()) throw new Error("设置视图仍包含会话侧栏。");
    },
  },
  {
    name: "plugins",
    run: async (page) => {
      await page.getByRole("button", { name: "插件中心" }).click();
      await page.getByText("@pi/demo-skills").first().waitFor();
    },
  },
];

// 主题断言期望：token v2 --label 随主题翻转（styles.css 主题变量层）。
const EXPECTED_LABEL = { dark: "#ffffff", light: "#000000" };

/** 双主题断言：dataset.theme / --label 计算值 / colorScheme 三者必须与目标主题一致。 */
export async function assertTheme(page, theme, scenarioName) {
  const actual = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    label: getComputedStyle(document.documentElement).getPropertyValue("--label").trim(),
    colorScheme: document.documentElement.style.colorScheme,
  }));
  const where = `[${theme}/${scenarioName}]`;
  if (actual.theme !== theme) {
    throw new Error(`${where} documentElement.dataset.theme 应为 ${theme}，实际为 ${JSON.stringify(actual.theme)}。`);
  }
  if (actual.label !== EXPECTED_LABEL[theme]) {
    throw new Error(`${where} --label 计算值应为 ${EXPECTED_LABEL[theme]}，实际为 ${JSON.stringify(actual.label)}。`);
  }
  if (actual.colorScheme !== theme) {
    throw new Error(`${where} colorScheme 应为 ${theme}，实际为 ${JSON.stringify(actual.colorScheme)}。`);
  }
}
