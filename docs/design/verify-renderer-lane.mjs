/**
 * 渲染层验收车道（Chromium + mock bridge）—— docs-internal/design-refresh-apple.md 第五节 D0。
 *
 * 覆盖边界：本车道只验收纯渲染层（React DOM）——新对话 / 活跃对话 / 设置 / 插件中心
 * 四个场景 × dark/light 双主题截图。window.piDesktop 由 addInitScript 注入完整 mock，
 * 不经过 Electron preload/IPC，因此**不覆盖**终端真实状态、原生 WebContentsView
 * 浏览器视图、窗口背景色——这些走 verify-electron-lane.mjs。
 *
 * 共享实现（dev server 引导 / mock / 场景 / 主题断言）在 verify-lane-lib.mjs，
 * mock 的契约同步维护要求见该文件头。
 *
 * 用法：
 *   node docs/design/verify-renderer-lane.mjs [--smoke] [输出目录]
 *   输出目录也可用环境变量 SHOTS_DIR 指定，默认 docs/design/shots/。
 *   --smoke 保留四场景 × 双主题与 console/pageerror 门禁，仅跳过对 CI 负载敏感的
 *   PERF-01 时延/长会话探针；不传参数时仍执行完整车道。
 *   浏览器二进制缺失时先跑 pnpm verify:setup。
 *   页面出现任何 console error / pageerror，或双主题断言失败时以非零码退出。
 */
import fs from "node:fs";
import path from "node:path";
import {
  BASE_URL,
  assertTheme,
  chromium,
  ensureDevServer,
  installMockBridge,
  installSignalHandlers,
  killServer,
  scenarios,
} from "./verify-lane-lib.mjs";

const args = process.argv.slice(2);
const smokeOnly = args.includes("--smoke");
const outputArg = args.find((arg) => !arg.startsWith("--"));
const outputDir = path.resolve(outputArg ?? process.env.SHOTS_DIR ?? path.join(import.meta.dirname, "shots"));
fs.mkdirSync(outputDir, { recursive: true });

let serverProcess = null;
installSignalHandlers(() => serverProcess);

serverProcess = await ensureDevServer();
const consoleErrors = [];
let browser;

const PERFORMANCE_TURN_COUNT = 100;
const PERFORMANCE_LAST_MESSAGE_CHARACTERS = 50_000;
const PERFORMANCE_TOOL_ACTIVITY_COUNT = 20;
const CONVERSATION_DOM_TURN_LIMIT = 49; // 48 viewport turns + one pinned running turn.
const STREAMING_REFRESH_BUDGET_MS = 60;

async function conversationScrollState(page) {
  return page.locator("[data-conversation-window-size]").evaluate((list) => {
    const viewport = list.parentElement?.parentElement;
    if (!(viewport instanceof HTMLElement)) throw new Error("未找到会话滚动视口。");
    return {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      bottomDistance: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
    };
  });
}

async function scrollConversation(page, destination) {
  await page.locator("[data-conversation-window-size]").evaluate((list, next) => {
    const viewport = list.parentElement?.parentElement;
    if (!(viewport instanceof HTMLElement)) throw new Error("未找到会话滚动视口。");
    if (next !== "bottom") {
      viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: next === "top" ? -120 : 120 }));
    }
    viewport.scrollTop = next === "top"
      ? 0
      : next === "middle"
        ? (viewport.scrollHeight - viewport.clientHeight) / 2
        : viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
  }, destination);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function mountedTurnIds(page) {
  return page.locator("[data-virtual-turn-id]").evaluateAll((turns) => turns.map((turn) => turn.getAttribute("data-virtual-turn-id")));
}

async function assertPerformanceConversation(page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "今天想一起做什么？" }).waitFor();
  await page.locator(".material-sidebar").getByRole("button", { name: /^排查验收车道截图脚本/ }).click();
  const virtualList = page.locator("[data-conversation-window-size]");
  await virtualList.waitFor();
  await page.locator('[data-virtual-turn-id="perf-turn-99"] .markdown-content').waitFor();

  const fixture = await page.evaluate(() => window.piVerify?.fixture);
  if (fixture?.turns !== PERFORMANCE_TURN_COUNT
    || fixture.lastMessageCharacters !== PERFORMANCE_LAST_MESSAGE_CHARACTERS
    || fixture.toolActivities !== PERFORMANCE_TOOL_ACTIVITY_COUNT) {
    throw new Error(`[PERF-01] fixture 形状异常：${JSON.stringify(fixture)}。`);
  }
  const tail = page.locator('[data-virtual-turn-id="perf-turn-99"]');
  const renderedMarkdownCharacters = await tail.locator(".markdown-content").textContent().then((text) => text?.length ?? 0);
  if (renderedMarkdownCharacters < 49_900) {
    throw new Error(`[PERF-01] 末条 50k Markdown 未真实渲染，DOM textContent 仅 ${renderedMarkdownCharacters} 字符。`);
  }
  if (await tail.locator("table").count() !== 1 || await tail.locator("pre code").count() < 1) {
    throw new Error("[PERF-01] 末条 Markdown 表格或代码块未渲染。 ");
  }
  await tail.getByRole("button", { name: /调用了多个工具/ }).click();
  if (await tail.locator('[data-state="open"]').getByRole("button").count() < PERFORMANCE_TOOL_ACTIVITY_COUNT) {
    throw new Error("[PERF-01] 20 条 tool activity 未全部进入真实 DOM。");
  }

  const initialIds = await mountedTurnIds(page);
  if (initialIds.length > CONVERSATION_DOM_TURN_LIMIT) {
    throw new Error(`[PERF-01] 初始 DOM turn 数 ${initialIds.length} 超出上限 ${CONVERSATION_DOM_TURN_LIMIT}。`);
  }
  const initialWindowSize = Number(await virtualList.getAttribute("data-conversation-window-size"));
  if (initialWindowSize !== initialIds.length) {
    throw new Error(`[PERF-01] 窗口元数据 ${initialWindowSize} 与真实挂载 ${initialIds.length} 不一致。`);
  }
  await page.waitForFunction(() => {
    const list = document.querySelector("[data-conversation-window-size]");
    const viewport = list?.parentElement?.parentElement;
    return viewport instanceof HTMLElement && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80;
  }, undefined, { timeout: 5_000 }).catch(() => {});
  const initialScroll = await conversationScrollState(page);
  if (initialScroll.bottomDistance > 80) {
    throw new Error(`[PERF-01] 初次打开未跟随最新内容，距底部 ${initialScroll.bottomDistance}px。`);
  }

  // 创建真实 running turn，再通过 React 订阅的 Agent event 路径测量
  // 事件 batching 到 DOM mutation 的端到端耗时。历史恢复会按契约归一为 completed。
  const streamingQuestion = "PERF-01 streaming probe";
  await page.getByLabel("继续对话").fill(streamingQuestion);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const streamingTurn = page.locator(`[data-virtual-turn-id]:has-text("${streamingQuestion}")`);
  await streamingTurn.waitFor();
  const streamingElapsed = await page.evaluate(async () => {
    const target = [...document.querySelectorAll("[data-virtual-turn-id]")]
      .find((turn) => turn.textContent?.includes("PERF-01 streaming probe"));
    if (!(target instanceof HTMLElement) || !window.piVerify) throw new Error("性能 fixture hook 未就绪。");
    const marker = " PERF_STREAM_MARKER";
    const startedAt = performance.now();
    const rendered = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => { observer.disconnect(); reject(new Error("等待流式 DOM 刷新超时。")); }, 1_000);
      const observer = new MutationObserver(() => {
        if (!target.textContent?.includes(marker.trim())) return;
        window.clearTimeout(timeout);
        observer.disconnect();
        resolve(performance.now() - startedAt);
      });
      observer.observe(target, { childList: true, characterData: true, subtree: true });
    });
    window.piVerify.emitAgentEvent({ type: "message.delta", conversationId: "conv-demo-1", runId: "mock-run", text: marker });
    return rendered;
  });
  if (streamingElapsed > STREAMING_REFRESH_BUDGET_MS) {
    const warmStreamingElapsed = await page.evaluate(async () => {
      const target = [...document.querySelectorAll("[data-virtual-turn-id]")]
        .find((turn) => turn.textContent?.includes("PERF-01 streaming probe"));
      if (!(target instanceof HTMLElement) || !window.piVerify) throw new Error("性能 fixture hook 未就绪。");
      const marker = " PERF_WARM_MARKER";
      const startedAt = performance.now();
      const rendered = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => { observer.disconnect(); reject(new Error("等待热态流式 DOM 刷新超时。")); }, 1_000);
        const observer = new MutationObserver(() => {
          if (!target.textContent?.includes(marker.trim())) return;
          window.clearTimeout(timeout);
          observer.disconnect();
          resolve(performance.now() - startedAt);
        });
        observer.observe(target, { childList: true, characterData: true, subtree: true });
      });
      window.piVerify.emitAgentEvent({ type: "message.delta", conversationId: "conv-demo-1", runId: "mock-run", text: marker });
      return rendered;
    });
    throw new Error(
      `[PERF-01] 流式 DOM 刷新冷态 ${streamingElapsed.toFixed(1)}ms / 热态 ${warmStreamingElapsed.toFixed(1)}ms，`
      + `上限 ${STREAMING_REFRESH_BUDGET_MS}ms。`,
    );
  }
  const followedScroll = await conversationScrollState(page);
  if (followedScroll.bottomDistance > 80) {
    throw new Error(`[PERF-01] 流式更新后未保持底部跟随，距底部 ${followedScroll.bottomDistance}px。`);
  }

  await scrollConversation(page, "top");
  await page.locator('[data-virtual-turn-id="perf-turn-0"]').waitFor();
  const topIds = await mountedTurnIds(page);
  if (topIds.length > CONVERSATION_DOM_TURN_LIMIT || initialIds.join() === topIds.join()) {
    throw new Error(`[PERF-01] 顶部窗口未随视口移动或超限：${topIds.length} turns。`);
  }
  const topBeforeUpdate = await conversationScrollState(page);
  await page.evaluate(() => window.piVerify?.emitAgentEvent({ type: "message.delta", conversationId: "conv-demo-1", runId: "mock-run", text: " PERF_UNREAD_MARKER" }));
  const returnToLatest = page.getByRole("button", { name: /有新内容.*回到最新/ });
  await returnToLatest.waitFor();
  const topAfterUpdate = await conversationScrollState(page);
  if (Math.abs(topAfterUpdate.scrollTop - topBeforeUpdate.scrollTop) > 2) {
    throw new Error(`[PERF-01] 向上阅读时流式内容破坏滚动锚点：${topBeforeUpdate.scrollTop} -> ${topAfterUpdate.scrollTop}。`);
  }

  await scrollConversation(page, "middle");
  const middleIds = await mountedTurnIds(page);
  if (middleIds.length > CONVERSATION_DOM_TURN_LIMIT || middleIds.join() === topIds.join()) {
    throw new Error(`[PERF-01] 中部窗口未随视口移动或超限：${middleIds.length} turns。`);
  }

  // 原生 button 必须可由键盘激活；Enter 后恢复流式跟随和底部窗口。
  await returnToLatest.focus();
  if (!await returnToLatest.evaluate((button) => button === document.activeElement)) {
    throw new Error("[UX-01] “回到最新”按钮无法获得键盘焦点。");
  }
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const list = document.querySelector("[data-conversation-window-size]");
    const viewport = list?.parentElement?.parentElement;
    return viewport instanceof HTMLElement && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80;
  });
  const bottomIds = await mountedTurnIds(page);
  if (!bottomIds.includes("perf-turn-99") || bottomIds.length > CONVERSATION_DOM_TURN_LIMIT) {
    throw new Error(`[PERF-01] 回到底部后的窗口异常：${bottomIds.length} turns。`);
  }

  const liveRegion = page.locator('[aria-label="当前对话"] > [role="status"][aria-live="polite"][aria-atomic="true"]');
  if (await liveRegion.count() !== 1) throw new Error("[UX-01] 当前对话缺少 polite + atomic live region。");
  await page.evaluate(() => window.piVerify?.emitAgentEvent({ type: "run.completed", conversationId: "conv-demo-1", runId: "mock-run" }));
  await liveRegion.getByText("任务已完成").waitFor();

  console.log(
    `[renderer-lane] PERF-01 通过：100 turns / 50k Markdown / 20 tools；`
    + `DOM ≤ ${CONVERSATION_DOM_TURN_LIMIT}；流式刷新 ${streamingElapsed.toFixed(1)}ms；视口窗口/滚动锚点/回底/live region 通过。`,
  );
}

try {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(`Chromium 启动失败：${err.message}\n提示：浏览器二进制缺失时请先运行 pnpm verify:setup 安装。`);
  }
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`[${theme}] console: ${message.text()}`);
    });
    page.on("pageerror", (err) => consoleErrors.push(`[${theme}] pageerror: ${err.message}`));
    await page.addInitScript(installMockBridge);
    await page.addInitScript((value) => window.localStorage.setItem("pi-theme", value), theme);
    for (const scenario of scenarios) {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await scenario.run(page);
      await assertTheme(page, theme, scenario.name);
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(outputDir, `renderer-${scenario.name}-${theme}.png`);
      await page.screenshot({ path: file });
      console.log(`[renderer-lane] ${file}`);
    }
    await page.close();
  }

  if (!smokeOnly) {
    const performancePage = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    performancePage.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`[performance] console: ${message.text()}`);
    });
    performancePage.on("pageerror", (err) => consoleErrors.push(`[performance] pageerror: ${err.message}`));
    await performancePage.addInitScript(installMockBridge, { performanceConversation: true });
    await performancePage.addInitScript(() => window.localStorage.setItem("pi-theme", "dark"));
    await assertPerformanceConversation(performancePage);
    await performancePage.close();
  }
} finally {
  await browser?.close();
  await killServer(serverProcess);
}

if (consoleErrors.length) {
  console.error(`浏览器 console/pageerror：\n${consoleErrors.join("\n")}`);
  process.exit(1);
}
console.log(smokeOnly
  ? "[renderer-lane] smoke 通过：8 张渲染层截图已产出，四场景双主题断言通过，无 console/pageerror。"
  : "[renderer-lane] 通过：8 张渲染层截图与 PERF-01 长会话真实 DOM 验证已完成，双主题断言通过，无 console/pageerror。");
