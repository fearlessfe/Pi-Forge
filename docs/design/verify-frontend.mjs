import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const outputDir = path.resolve(import.meta.dirname);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];

await page.addInitScript(() => window.localStorage.setItem("pi-theme", "dark"));

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "今天想一起做什么？" }).waitFor();
await page.screenshot({ path: path.join(outputDir, "implementation-01-new-chat-dark.png") });

await page.getByRole("button", { name: "选择目录" }).click();
await page.getByText("pi-desktop", { exact: true }).last().click();
await page.getByRole("heading", { name: "在 pi-desktop 中开始新对话" }).waitFor();
await page.screenshot({ path: path.join(outputDir, "implementation-02-project-dark.png") });

await page.getByRole("button", { name: /Pengzhen/ }).click();
await page.getByRole("menuitem", { name: /^设置/ }).click();
await page.getByRole("heading", { name: "大模型" }).waitFor();
if (await page.locator(".material-sidebar").count()) throw new Error("Settings view still contains the conversation sidebar.");
await page.screenshot({ path: path.join(outputDir, "implementation-03-settings-dark.png") });

await page.getByRole("button", { name: "外观" }).click();
await page.getByRole("button", { name: /浅色/ }).click();
await page.getByRole("button", { name: "返回对话" }).click();
await page.getByRole("heading", { name: "在 pi-desktop 中开始新对话" }).waitFor();
await page.screenshot({ path: path.join(outputDir, "implementation-04-project-light.png") });

if (consoleErrors.length) throw new Error(`Browser console errors:\n${consoleErrors.join("\n")}`);
await browser.close();
