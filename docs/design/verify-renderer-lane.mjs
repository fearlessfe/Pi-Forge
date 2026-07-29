/**
 * 渲染层验收车道（Chromium + mock bridge）—— docs/design-refresh-apple.md 第五节 D0。
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
 *   node docs/design/verify-renderer-lane.mjs [输出目录]
 *   输出目录也可用环境变量 SHOTS_DIR 指定，默认 docs/design/shots/。
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

const outputDir = path.resolve(process.argv[2] ?? process.env.SHOTS_DIR ?? path.join(import.meta.dirname, "shots"));
fs.mkdirSync(outputDir, { recursive: true });

let serverProcess = null;
installSignalHandlers(() => serverProcess);

serverProcess = await ensureDevServer();
const consoleErrors = [];
let browser;
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
} finally {
  await browser?.close();
  await killServer(serverProcess);
}

if (consoleErrors.length) {
  console.error(`浏览器 console/pageerror：\n${consoleErrors.join("\n")}`);
  process.exit(1);
}
console.log("[renderer-lane] 通过：8 张渲染层截图已产出，双主题断言通过，无 console/pageerror。");
