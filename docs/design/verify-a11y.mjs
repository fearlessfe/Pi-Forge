/**
 * 可访问性验收车道（Chromium + mock bridge）—— docs-internal/design-refresh-apple.md 第六节
 * 验收矩阵第 3/5/6 项（reducedMotion / 缩放 / forced-colors）的自动化补证。
 *
 * 覆盖三组检查（均走渲染层 mock，共享 verify-lane-lib.mjs）：
 *   A. reducedMotion: "reduce" —— 断言装饰动画归零、spinner 降频保留（1.6s infinite）、
 *      transition 近零（探针取明确带 duration-150 的侧栏导航按钮），
 *      并截 new-chat / active-chat 深色 2 张图。
 *   B. forcedColors: "active" —— 模拟 Windows 高对比，断言焦点环 outline 仍由系统接管可见
 *      （composer 输入框 + 侧栏导航按钮 focus 后 outline 宽度 2px），
 *      并截 new-chat 深色 / settings 浅色 2 张图。
 *   C. 缩放 125% / 150% —— 用「CSS 视口 ÷ 缩放比 + deviceScaleFactor」近似页面缩放，
 *      断言无横向溢出且关键控件（窗口栏、composer 卡片）boundingBox 完全在视口内；
 *      场景覆盖 new-chat（125%/150%）与 settings / plugins（150%），共 4 张图。
 *
 * 用法：
 *   node docs/design/verify-a11y.mjs [输出目录]
 *   输出目录也可用环境变量 SHOTS_DIR 指定，默认 docs/design/shots/。
 *   任一断言失败或页面 console error/pageerror 时以非零码退出。
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

const outputDir = path.resolve(process.argv[2] ?? process.env.SHOTS_DIR ?? path.join(import.meta.dirname, "shots"));
fs.mkdirSync(outputDir, { recursive: true });

const scenarioByName = Object.fromEntries(scenarios.map((scenario) => [scenario.name, scenario]));

let serverProcess = null;
installSignalHandlers(() => serverProcess);

async function openPage(browser, theme, contextOptions = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    ...contextOptions,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`[${theme}] console: ${message.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[${theme}] pageerror: ${err.message}`));
  await page.addInitScript(installMockBridge);
  await page.addInitScript((value) => window.localStorage.setItem("pi-theme", value), theme);
  return { context, page };
}

async function gotoScenario(page, theme, name) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await scenarioByName[name].run(page);
  await assertTheme(page, theme, name);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page, file) {
  await page.screenshot({ path: file });
  console.log(`[a11y-lane] ${file}`);
}

/** A 组：reduced-motion 断言。用探针元素直接命中定制层规则，不依赖运行中的任务态。 */
async function assertReducedMotion(page) {
  const result = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.innerHTML = `<i class="is-spinning"></i><span class="task-status-signal"><i></i><i></i><i></i></span><span class="activity-spinner"></span>`;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const seconds = (value) => {
      // computed 时间值序列化为 "1.6s" 或 "0.00001s"（ms 会归一为 s）
      const match = /^([\d.e-]+)(m?s)$/.exec(value.trim());
      if (!match) return Number.NaN;
      return match[2] === "ms" ? Number(match[1]) / 1000 : Number(match[1]);
    };
    const spinning = seconds(getComputedStyle(probe.querySelector(".is-spinning")).animationDuration);
    const spinnerStyle = getComputedStyle(probe.querySelector(".activity-spinner"));
    const spinner = seconds(spinnerStyle.animationDuration);
    const spinnerIterations = spinnerStyle.animationIterationCount;
    const wave = seconds(getComputedStyle(probe.querySelector(".task-status-signal > i")).animationDuration);
    // transition 探针：明确带 duration-150 的侧栏导航按钮（3.2 动效契约的两档之一）。
    const navButton = document.querySelector(".material-sidebar button");
    const navHasDuration = navButton?.className.includes("duration-150") ?? false;
    const transition = navButton ? seconds(getComputedStyle(navButton).transitionDuration) : Number.NaN;
    const media = matchMedia("(prefers-reduced-motion: reduce)").matches;
    probe.remove();
    return { media, spinning, spinner, spinnerIterations, wave, navHasDuration, transition };
  });
  if (!result.media) throw new Error("[reduce] matchMedia(prefers-reduced-motion: reduce) 未命中。");
  if (!(result.spinning > 1)) throw new Error(`[reduce] .is-spinning 应降频保留（>1s），实际 ${result.spinning}s。`);
  if (result.spinnerIterations !== "infinite" || Math.abs(result.spinner - 1.6) > 0.01) {
    throw new Error(`[reduce] .activity-spinner 应降频保留（1.6s infinite），实际 ${result.spinner}s / ${result.spinnerIterations}。`);
  }
  if (!(result.wave < 0.001)) throw new Error(`[reduce] 装饰动画（信号柱波浪）应归零，实际 ${result.wave}s。`);
  if (!result.navHasDuration) throw new Error("[reduce] 未找到带 duration-150 的侧栏导航按钮作为 transition 探针。");
  if (!(result.transition < 0.001)) throw new Error(`[reduce] 侧栏导航按钮 transition 时长应近零，实际 ${result.transition}s。`);
  console.log("[a11y-lane] reduce 断言通过：装饰动画归零、spinner 1.6s infinite、duration-150 transition 近零。");
}

/** B 组：forced-colors 断言。聚焦 composer 输入框与侧栏导航按钮，检查全局 :focus-visible outline 仍存在。 */
async function assertForcedColorsFocusRing(page) {
  const composer = page.locator("textarea").first();
  await composer.focus();
  const ring = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  if (ring.outlineStyle !== "solid" || Number.parseFloat(ring.outlineWidth) < 1) {
    throw new Error(`[forced-colors] 焦点环不可见：outline ${ring.outlineWidth} ${ring.outlineStyle}。`);
  }
  console.log(`[a11y-lane] forced-colors 断言通过：composer 焦点 outline ${ring.outlineWidth} ${ring.outlineStyle} 保留。`);

  // 侧栏导航按钮：先按 Tab 建立键盘模态（Chromium 的 :focus-visible 启发式），再 focus 断言 2px outline。
  const navButton = page.locator(".material-sidebar button").first();
  await page.keyboard.press("Tab");
  await navButton.focus();
  const navRing = await navButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  if (!navRing.focusVisible || navRing.outlineStyle !== "solid" || navRing.outlineWidth !== "2px") {
    throw new Error(
      `[forced-colors] 侧栏导航按钮焦点环异常：:focus-visible=${navRing.focusVisible}，`
      + `outline ${navRing.outlineWidth} ${navRing.outlineStyle}（应为 2px solid）。`,
    );
  }
  console.log("[a11y-lane] forced-colors 断言通过：侧栏导航按钮 focus 后 outline 2px solid 保留。");
}

/** C 组：缩放断言。无横向溢出（body min-width 960px 远小于缩放后视口），且关键控件完全在视口内。 */
async function assertNoOverflow(page, zoom) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    throw new Error(`[zoom ${zoom}] 横向溢出：scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}。`);
  }
  console.log(`[a11y-lane] zoom ${zoom} 断言通过：无横向溢出（clientWidth ${overflow.clientWidth}）。`);
}

/** 关键控件的 boundingBox 必须完全落在视口内（窗口栏全场景；composer 卡片限新对话）。 */
async function assertControlsInViewport(page, zoom, controls) {
  const viewport = page.viewportSize();
  for (const { name, locator } of controls) {
    const box = await locator.first().boundingBox();
    if (!box) throw new Error(`[zoom ${zoom}] 关键控件「${name}」不可见（无 boundingBox）。`);
    const inside = box.x >= -0.5 && box.y >= -0.5
      && box.x + box.width <= viewport.width + 0.5 && box.y + box.height <= viewport.height + 0.5;
    if (!inside) {
      throw new Error(
        `[zoom ${zoom}] 关键控件「${name}」超出视口：box ${JSON.stringify(box)}，viewport ${viewport.width}x${viewport.height}。`,
      );
    }
  }
  console.log(`[a11y-lane] zoom ${zoom} 断言通过：${controls.map((control) => control.name).join("、")}均在视口内。`);
}

const consoleErrors = [];
serverProcess = await ensureDevServer();
let browser;
try {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(`Chromium 启动失败：${err.message}\n提示：浏览器二进制缺失时请先运行 pnpm verify:setup 安装。`);
  }

  // A. reducedMotion
  {
    const { context, page } = await openPage(browser, "dark", { reducedMotion: "reduce" });
    await gotoScenario(page, "dark", "new-chat");
    await assertReducedMotion(page);
    await shot(page, path.join(outputDir, "a11y-reduced-motion-new-chat-dark.png"));
    await gotoScenario(page, "dark", "active-chat");
    await shot(page, path.join(outputDir, "a11y-reduced-motion-active-chat-dark.png"));
    await context.close();
  }

  // B. forcedColors
  {
    const { context, page } = await openPage(browser, "dark", { forcedColors: "active" });
    await gotoScenario(page, "dark", "new-chat");
    await assertForcedColorsFocusRing(page);
    await shot(page, path.join(outputDir, "a11y-forced-colors-new-chat-dark.png"));
    await context.close();
  }
  {
    const { context, page } = await openPage(browser, "light", { forcedColors: "active" });
    await gotoScenario(page, "light", "settings");
    await shot(page, path.join(outputDir, "a11y-forced-colors-settings-light.png"));
    await context.close();
  }

  // C. 缩放 125% / 150%：CSS 视口除以缩放比 + deviceScaleFactor 近似页面缩放。
  // 场景矩阵：new-chat 跑 125%/150%，settings / plugins 补 150%（验收矩阵第 5 项）。
  const windowBar = (page) => ({ name: "窗口栏", locator: page.locator("header.material-chrome") });
  const composerCard = (page) => ({ name: "composer 卡片", locator: page.locator("form:has(textarea)") });
  const zoomScenarios = [
    { zoom: 1.25, scene: "new-chat", controls: (page) => [windowBar(page), composerCard(page)] },
    { zoom: 1.5, scene: "new-chat", controls: (page) => [windowBar(page), composerCard(page)] },
    { zoom: 1.5, scene: "settings", controls: (page) => [windowBar(page)] },
    { zoom: 1.5, scene: "plugins", controls: (page) => [windowBar(page)] },
  ];
  for (const { zoom, scene, controls } of zoomScenarios) {
    const { context, page } = await openPage(browser, "dark", {
      viewport: { width: Math.round(1440 / zoom), height: Math.round(900 / zoom) },
      deviceScaleFactor: zoom,
    });
    await gotoScenario(page, "dark", scene);
    // 150% 下有效视口 960x600 < 根 section 的 min-h-170（680px），Playwright 点击折叠线
    // 以下的「Pi 用户」按钮会自动滚动根滚动条——这是测试操作伪影（真实窗口不滚动），
    // 复原到真实初始位置（顶对齐）再做溢出与视口断言。
    await page.evaluate(() => window.scrollTo(0, 0));
    await assertNoOverflow(page, zoom);
    await assertControlsInViewport(page, zoom, controls(page));
    await shot(page, path.join(outputDir, `a11y-zoom-${Math.round(zoom * 100)}-${scene}-dark.png`));
    await context.close();
  }
} finally {
  await browser?.close();
  await killServer(serverProcess);
}

if (consoleErrors.length) {
  console.error(`浏览器 console/pageerror：\n${consoleErrors.join("\n")}`);
  process.exit(1);
}
console.log("[a11y-lane] 通过：reduced-motion / forced-colors / 缩放 125%·150% 断言全绿，8 张截图已产出。");
