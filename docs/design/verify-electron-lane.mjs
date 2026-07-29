/**
 * Electron 验收车道（Playwright _electron.launch）—— docs/design-refresh-apple.md 第五节 D0。
 *
 * 覆盖边界：本车道验证真实 Electron 运行时——真实 preload/IPC、窗口背景色断言、
 * documentElement 主题标记。D0 最小闭环：启动 → App 渲染 → 主题断言 →
 * 断言 BrowserWindow 背景色 → 整窗截图；D4-1 扩展：经真实 UI（用户菜单 → 设置 →
 * 外观 → 主题按钮 → 返回对话）双向切换主题，断言背景色随之翻转并复原，
 * 覆盖 App → preload → appearance:set-theme → main 的完整链路。
 * D4-2 扩展（设计文档第六节场景矩阵的 Electron 部分）：
 *   - 终端场景：真实 UI 打开终端（真实 node-pty），断言终端工作区容器计算背景与
 *     .xterm-screen 区域渲染底色均与 styles.css --terminal-background 当前主题值一致
 *     （dark #090c11 / light #ffffff），双主题各一张截图；
 *   - 浏览器工作台场景：真实 UI 链路（终端检出本地服务地址 → 「在内置浏览器中打开」）
 *     打开 BrowserWorkbench，主进程拿到原生 WebContentsView 后 capturePage 取证，
 *     角落像素断言对齐 viewBackground（dark #1C1C1E / light #F5F5F7），双主题各一组截图。
 *
 * 注意：`page.screenshot()` 的整窗截图**不包含独立合成的 WebContentsView**（原生浏览器
 * 视图），原生视图的主题覆盖以该视图 `webContents.capturePage()` 的存盘图为准
 * （electron-browser-view-*.png）。
 *
 * 用法：
 *   node docs/design/verify-electron-lane.mjs [输出目录]
 *   输出目录也可用环境变量 SHOTS_DIR 指定，默认 docs/design/shots/。
 *   构建产物缺失或过期时自动执行 pnpm --filter @pi-desktop/renderer build。
 *   浏览器/运行时二进制缺失时先跑 pnpm verify:setup。
 *   应用用户数据通过 PI_DESKTOP_USER_DATA 重定向到临时目录，退出时清理。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// 必须在 require playwright 之前设置：浏览器二进制装在 workspace 的 node_modules 内。
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { _electron } = require("playwright");
const { PNG } = require("pngjs");

const repoRoot = path.resolve(import.meta.dirname, "../..");
const appDir = path.join(repoRoot, "apps/desktop");
const mainJs = path.join(appDir, "dist-electron/electron/main.js");
const rendererHtml = path.join(appDir, "dist/index.html");
const outputDir = path.resolve(process.argv[2] ?? process.env.SHOTS_DIR ?? path.join(import.meta.dirname, "shots"));

// D4（3.6 跨进程主题链路）后：BrowserWindow 背景对齐 token v2 的 --bg-window
// （styles.css 主题变量层），深色 #1C1C1E / 浅色 #F5F5F7。
// 主进程初始背景取 AppearanceStore 持久化的最近主题（无记录默认深色）；渲染进程
// mount 后 effect 经 appearance:set-theme 纠正并持久化，因此断言前轮询等待同步完成。
const EXPECTED_BACKGROUND = { dark: "#1C1C1E", light: "#F5F5F7" };

// 终端工作区底色：styles.css 主题变量层 --terminal-background（3.6 渲染进程内 TS 主题同步）。
const EXPECTED_TERMINAL_BACKGROUND = { dark: "#090c11", light: "#ffffff" };

// macOS hiddenInset 标题栏的外框→内容区换算会随 Electron/系统小版本在 897/898px
// 间波动。截图前固定内容区尺寸，避免同一界面只因 1 个 CSS px（Retina 下 2px）
// 被黄金图门禁误判；现有 golden 主窗口内容区即 1440×897。
const VERIFICATION_CONTENT_SIZE = { width: 1440, height: 897 };

fs.mkdirSync(outputDir, { recursive: true });

function newestMtime(entry) {
  const stat = fs.statSync(entry);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs.readdirSync(entry).reduce((latest, child) => Math.max(latest, newestMtime(path.join(entry, child))), stat.mtimeMs);
}

function ensureBuild() {
  const outputsExist = fs.existsSync(mainJs) && fs.existsSync(rendererHtml);
  const stale = outputsExist && (
    newestMtime(path.join(appDir, "electron")) > fs.statSync(mainJs).mtimeMs
    || newestMtime(path.join(appDir, "src")) > fs.statSync(rendererHtml).mtimeMs
  );
  if (outputsExist && !stale) return;
  console.log(outputsExist ? "[electron-lane] 构建产物过期，重新构建…" : "[electron-lane] 构建产物缺失，开始构建…");
  const result = spawnSync("pnpm", ["--filter", "@pi-desktop/renderer", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error("pnpm --filter @pi-desktop/renderer build 失败。");
}

ensureBuild();

// 用户数据隔离：首次运行的设置/凭据写入临时目录，不污染真实用户配置。
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-verify-"));
const consoleErrors = [];
const attachedPages = new Set();

/** 页面级监听：console error 与 pageerror（D0 仅收集打印，见文件尾处理）。 */
function attachPageListeners(page) {
  if (attachedPages.has(page)) return;
  attachedPages.add(page);
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
}

let electronApp;
try {
  try {
    electronApp = await _electron.launch({
      args: [mainJs],
      cwd: appDir,
      env: {
        ...process.env,
        PI_DESKTOP_USER_DATA: userDataDir,
        PI_DESKTOP_DISABLE_VIBRANCY: "1",
        PI_DESKTOP_THEME_SOURCE: "light",
      },
      timeout: 120_000,
    });
  } catch (err) {
    throw new Error(`Electron 启动失败：${err.message}\n提示：浏览器/运行时二进制缺失时请先运行 pnpm verify:setup 安装。`);
  }
  // 尽早挂监听：electronApp 级别的 window 事件覆盖 launch 后创建的所有窗口，
  // 不遗漏 firstWindow() 解析之前产生的 console/pageerror。
  electronApp.on("window", attachPageListeners);
  const page = await electronApp.firstWindow();
  attachPageListeners(page);
  const windowHandle = await electronApp.browserWindow(page);
  await stabilizeContentSize(page, windowHandle);

  await sceneMainWindow(page, windowHandle);
  await sceneTerminal(page, windowHandle);
  await sceneBrowser(page, electronApp, windowHandle);
} finally {
  await electronApp?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

if (consoleErrors.length) {
  console.warn(`[electron-lane] 渲染进程 console/pageerror（D0 仅打印不拦截）：\n${consoleErrors.join("\n")}`);
}
console.log("[electron-lane] 通过：Electron 主窗口 + 终端 + 浏览器工作台场景完成。");

/** 固定截图内容区尺寸，消除 macOS 标题栏换算导致的 1 CSS px 非确定性。 */
async function stabilizeContentSize(page, windowHandle) {
  await windowHandle.evaluate((win, size) => win.setContentSize(size.width, size.height), VERIFICATION_CONTENT_SIZE);
  const deadline = Date.now() + 10_000;
  let actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  while (
    (actual.width !== VERIFICATION_CONTENT_SIZE.width || actual.height !== VERIFICATION_CONTENT_SIZE.height)
    && Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  }
  if (actual.width !== VERIFICATION_CONTENT_SIZE.width || actual.height !== VERIFICATION_CONTENT_SIZE.height) {
    throw new Error(
      `Electron 验收内容区尺寸应为 ${VERIFICATION_CONTENT_SIZE.width}x${VERIFICATION_CONTENT_SIZE.height}，`
      + `实际为 ${actual.width}x${actual.height}。`,
    );
  }
  console.log(`[electron-lane] 内容区尺寸固定为 ${actual.width}x${actual.height}（断言通过）`);
}

/** D0 主窗口场景：渲染就绪 → 主题断言 → 窗口背景色断言 → 主题切换往返断言 → 整窗截图。 */
async function sceneMainWindow(page, windowHandle) {
  await page.getByRole("heading", { name: "今天想一起做什么？" }).waitFor({ timeout: 60_000 });

  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== "dark" && theme !== "light") {
    throw new Error(`documentElement.dataset.theme 应为 dark 或 light，实际为 ${JSON.stringify(theme)}。`);
  }
  console.log(`[electron-lane] 主题：${theme}`);

  await waitForBackground(windowHandle, theme);

  // D4-1 扩展：真实 UI 切换主题（用户菜单 → 设置 → 外观 → 主题按钮 → 返回对话），
  // 切到反色断言背景翻转，再切回断言复原，双向覆盖 App→preload→main 链路。
  await switchThemeViaSettings(page, windowHandle, theme === "dark" ? "light" : "dark");
  await switchThemeViaSettings(page, windowHandle, theme);

  // 注意：整窗截图不包含独立合成的 WebContentsView（见文件头注释）。
  const file = path.join(outputDir, "electron-main-window.png");
  await page.screenshot({ path: file });
  console.log(`[electron-lane] ${file}`);
}

/** D4-2 终端场景：真实 UI 打开终端（真实 node-pty），双主题断言 .xterm 背景并截图。 */
async function sceneTerminal(page, windowHandle) {
  const startTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const themes = [startTheme, startTheme === "dark" ? "light" : "dark"];
  for (const [index, theme] of themes.entries()) {
    if (index > 0) await switchThemeViaSettings(page, windowHandle, theme);
    await openTerminalPanel(page);
    await assertTerminalBackground(page, theme);
    const file = path.join(outputDir, `electron-terminal-${theme}.png`);
    await page.screenshot({ path: file });
    console.log(`[electron-lane] ${file}`);
    await page.getByRole("button", { name: "关闭终端面板" }).click();
  }
}

/** 打开终端面板并等待 xterm 就绪；回车触发新提示符，保证重连已有 pty 后画面有内容。
   注意：xterm 的输入 textarea 是视觉上隐藏的辅助元素（waitFor visible 会超时），
   点击 .xterm-screen 由 xterm 自己把焦点转交过去。 */
async function openTerminalPanel(page) {
  await page.getByRole("button", { name: "终端", exact: true }).click();
  const screen = page.locator(".xterm .xterm-screen").first();
  await screen.waitFor({ timeout: 30_000 });
  await screen.click();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
}

/** 断言终端底色与 --terminal-background 当前主题值一致（3.6 终端主题同步链路）。
   xterm 6 默认 DOM renderer：.xterm 容器透明、主题底色只涂已写入单元格，空白区由底层
   工作区容器（bg-terminal-bg）透出。因此分两层断言：DOM 计算值 + 对 .xterm-screen
   区域截图采样用户实际看到的底色（远离提示符字形的多数色）。 */
async function assertTerminalBackground(page, theme) {
  const expected = EXPECTED_TERMINAL_BACKGROUND[theme];
  const expectedRgb = hexToRgbString(expected);
  const expectedChannels = expectedRgb.match(/\d+/g).map(Number);
  const result = await page.evaluate(() => {
    const variable = getComputedStyle(document.documentElement).getPropertyValue("--terminal-background").trim().toLowerCase();
    const host = document.querySelector(".terminal-pane")?.closest(".bg-terminal-bg") ?? null;
    return { variable, hostBackground: host ? getComputedStyle(host).backgroundColor : null };
  });
  // 生产构建的 CSS 压缩会把 #ffffff 写成 #fff，比较前统一展开三位 hex。
  const normalized = result.variable.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3");
  if (normalized !== expected) {
    throw new Error(`[terminal] --terminal-background 应为 ${expected}（${theme} 主题），实际为 ${result.variable}。`);
  }
  if (result.hostBackground !== expectedRgb) {
    throw new Error(`[terminal] 工作区容器（bg-terminal-bg）计算背景应为 ${expectedRgb}（${theme} 主题），实际为 ${result.hostBackground}。`);
  }
  const clip = await page.locator(".xterm-screen").first().boundingBox();
  if (!clip) throw new Error("[terminal] .xterm-screen 不可见，无法采样渲染像素。");
  const png = PNG.sync.read(await page.screenshot({ clip }));
  const counts = new Map();
  for (const fy of [0.3, 0.55, 0.8, 0.95]) {
    for (const fx of [0.75, 0.85, 0.93]) {
      const x = Math.min(png.width - 1, Math.floor(png.width * fx));
      const y = Math.min(png.height - 1, Math.floor(png.height * fy));
      const offset = (y * png.width + x) * 4;
      const key = `${png.data[offset]},${png.data[offset + 1]},${png.data[offset + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const channels = majority.split(",").map(Number);
  const delta = Math.max(...channels.map((value, channel) => Math.abs(value - expectedChannels[channel])));
  if (delta > 6) {
    throw new Error(`[terminal] 终端渲染底色应为 ${expectedRgb}（--terminal-background ${expected}，${theme} 主题），实际多数色 rgb(${majority})，通道误差 ${delta} > 6。`);
  }
  console.log(`[electron-lane] 终端底色 ${result.hostBackground} / 渲染多数色 rgb(${majority})（${theme}，断言通过）`);
}

/**
 * D4-2 浏览器工作台场景：真实 UI 链路——终端里 echo 本地服务地址，URL 检测出现后点
 * 「在内置浏览器中打开」进入 BrowserWorkbench（BrowserService 建原生 WebContentsView
 * 并 setBackgroundColor(viewBackground[theme])）。capturePage 角落像素断言对齐
 * viewBackground（3.6）：视图停留 about:blank（网页未加载），基底像素即设置值。
 *
 * 环境兜底（http 加载 stub）：本机运行时下该 sandbox 渲染进程一发起 http 加载就
 * SIGSEGV（render-process-gone exitCode 11），且崩溃后对视图调 stop/loadURL 会连带
 * 杀死主进程——Electron/系统组合问题，与主题链路无关。因此点击前在渲染进程把
 * browser.navigate stub 成 no-op：视图改由工作台 mount 的 setVisible(true) 经
 * ensureView 创建（加载 about:blank 不触发崩溃）。被绕过的只有网页加载本身；
 * 视图创建、setBackgroundColor、主题切换 setTheme、bounds 同步仍是真实链路。
 */
async function sceneBrowser(page, electronApp, windowHandle) {
  // 本地服务地址仅用于触发终端 URL 检测（stub 后不会有真实连接）。
  const hangServer = net.createServer(() => {});
  await new Promise((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
  const hangUrl = `http://127.0.0.1:${hangServer.address().port}/`;
  try {
    const startTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    const themes = [startTheme, startTheme === "dark" ? "light" : "dark"];
    for (const [index, theme] of themes.entries()) {
      console.log(`[electron-lane] browser 场景 ${theme}：开始`);
      if (index > 0) await switchThemeViaSettings(page, windowHandle, theme);
      await openTerminalPanel(page);
      await page.keyboard.type(`echo ${hangUrl}`);
      await page.keyboard.press("Enter");
      // http 加载 stub（见头注）：navigate 不再触发真实网络加载。
      await page.evaluate(() => {
        const browser = window.piDesktop?.browser;
        if (browser && !browser.laneNavigateStubbed) {
          browser.laneNavigateStubbed = true;
          browser.navigate = () => browser.state();
        }
      });
      await page.getByRole("button", { name: /在内置浏览器中打开/ }).click({ timeout: 20_000 });
      await page.locator('main[aria-label="内置浏览器"]').waitFor({ timeout: 15_000 });
      await waitForBrowserViewReady(electronApp);
      await prepareBrowserViewCapture(electronApp);

      const viewFile = path.join(outputDir, `electron-browser-view-${theme}.png`);
      await captureBrowserView(electronApp, viewFile);
      assertBrowserViewBackground(viewFile, theme);

      // 工作台 chrome（工具栏/地址栏/状态栏）走 DOM，整页截图取证；原生视图部分以 capturePage 图为准。
      const file = path.join(outputDir, `electron-browser-${theme}.png`);
      await page.screenshot({ path: file });
      console.log(`[electron-lane] ${file}`);

      await page.getByRole("button", { name: "关闭内置浏览器" }).click();
      await page.getByRole("button", { name: "关闭终端面板" }).click();
    }
  } finally {
    hangServer.close();
  }
}

/** 等待原生 WebContentsView 挂载且 bounds 已同步到工作台 surface（ResizeObserver 异步）。 */
async function waitForBrowserViewReady(electronApp) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win?.contentView.children.find((child) => child.webContents.id !== win.webContents.id);
      if (!view) return false;
      const bounds = view.getBounds();
      return bounds.width > 200 && bounds.height > 200;
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("等待原生浏览器 WebContentsView 就绪（挂载 + bounds 同步）超时。");
}

/** 让视图进入可取证状态：强制可见（隐藏视图的渲染进程被合成节流）并留短暂合成窗口。
   本场景 navigate 已 stub（见 sceneBrowser 头注），视图只加载 about:blank；不轮询
   isLoading/getURL——该 sandbox 渲染进程在本机环境下 isLoading 会卡在 true（疑似与
   http 加载 SIGSEGV 同源的环境问题），capturePage 轮询非空图才是可靠就绪信号。 */
async function prepareBrowserViewCapture(electronApp) {
  const state = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win?.contentView.children.find((child) => child.webContents.id !== win.webContents.id);
    if (!view) return { ok: false, reason: "no-view" };
    if (view.webContents.isCrashed()) return { ok: false, reason: "crashed" };
    view.setVisible(true);
    return { ok: true };
  });
  if (!state?.ok) {
    throw new Error(`原生浏览器视图不可取证（${state?.reason ?? "未知"}）。`);
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
}

/** 主进程取原生 WebContentsView，capturePage 存盘（整窗截图不含该视图，必须单独取证）。
   挂起加载的视图可能尚未产出合成帧（capturePage 返回空图），轮询重试直到拿到非空 PNG。 */
async function captureBrowserView(electronApp, file) {
  const deadline = Date.now() + 15_000;
  let lastInfo = "";
  while (Date.now() < deadline) {
    const result = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { error: "no-window" };
      const view = win.contentView.children.find((child) => child.webContents.id !== win.webContents.id);
      if (!view) return { error: "no-view", children: win.contentView.children.length };
      const image = await view.webContents.capturePage();
      return {
        base64: image.toPNG().toString("base64"),
        size: image.getSize(),
        visible: view.getVisible(),
        url: view.webContents.getURL(),
        crashed: view.webContents.isCrashed(),
      };
    });
    if (result?.base64?.length > 100) {
      fs.writeFileSync(file, Buffer.from(result.base64, "base64"));
      console.log(`[electron-lane] ${file}`);
      return;
    }
    lastInfo = JSON.stringify({ ...result, base64: result?.base64?.length ?? null });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`原生浏览器视图 capturePage 超时或为空：${lastInfo}`);
}

/** 采样 capturePage 图四角像素，断言与 viewBackground 当前主题值一致（允许 ≤12 通道误差）。 */
function assertBrowserViewBackground(file, theme) {
  const expected = EXPECTED_BACKGROUND[theme];
  const expectedRgb = [expected.slice(1, 3), expected.slice(3, 5), expected.slice(5, 7)].map((value) => Number.parseInt(value, 16));
  const png = PNG.sync.read(fs.readFileSync(file));
  const corners = [[4, 4], [png.width - 5, 4], [4, png.height - 5], [png.width - 5, png.height - 5]];
  for (const [x, y] of corners) {
    const offset = (y * png.width + x) * 4;
    const actual = [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
    const delta = Math.max(...actual.map((value, channel) => Math.abs(value - expectedRgb[channel])));
    if (delta > 12) {
      throw new Error(
        `[browser] 原生视图角像素 (${x},${y}) 应为 ${expected}（${theme} 主题 viewBackground），`
        + `实际 rgb(${actual.join(", ")})，通道误差 ${delta} > 12。`,
      );
    }
  }
  console.log(`[electron-lane] 原生视图四角像素对齐 ${expected}（${theme}，断言通过）`);
}

function hexToRgbString(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/** 轮询断言 BrowserWindow 背景色到位（背景经 appearance:set-theme IPC 异步同步）。 */
async function waitForBackground(windowHandle, theme) {
  const expected = EXPECTED_BACKGROUND[theme];
  let backgroundColor = await windowHandle.evaluate((win) => win.getBackgroundColor());
  const deadline = Date.now() + 10_000;
  while (backgroundColor.toUpperCase() !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    backgroundColor = await windowHandle.evaluate((win) => win.getBackgroundColor());
  }
  if (backgroundColor.toUpperCase() !== expected) {
    throw new Error(`BrowserWindow 背景色应为 ${expected}（${theme} 主题，token v2 --bg-window），实际为 ${backgroundColor}。`);
  }
  console.log(`[electron-lane] BrowserWindow 背景色：${backgroundColor}（${theme}，断言通过）`);
}

/** 经设置界面把主题切到 target，断言 dataset.theme 与窗口背景同步，然后返回对话。 */
async function switchThemeViaSettings(page, windowHandle, target) {
  const targetLabel = target === "light" ? "浅色" : "深色";
  await page.getByRole("button", { name: /Pi 用户/ }).click();
  await page.getByRole("menuitem", { name: /^设置/ }).click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("button", { name: targetLabel, exact: true }).click();

  // dataset.theme 由 React 状态同步更新，轮询等待到位后再断言主进程背景。
  let applied = await page.evaluate(() => document.documentElement.dataset.theme);
  const deadline = Date.now() + 10_000;
  while (applied !== target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    applied = await page.evaluate(() => document.documentElement.dataset.theme);
  }
  if (applied !== target) {
    throw new Error(`点击「${targetLabel}」后 documentElement.dataset.theme 应为 ${target}，实际为 ${JSON.stringify(applied)}。`);
  }
  await waitForBackground(windowHandle, target);

  await page.getByRole("button", { name: "返回对话" }).click();
  await page.getByRole("heading", { name: "今天想一起做什么？" }).waitFor({ timeout: 30_000 });
  console.log(`[electron-lane] 主题经设置界面切换到 ${target} 并返回对话（断言通过）`);
}
