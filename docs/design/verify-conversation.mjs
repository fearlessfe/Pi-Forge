import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const outputDir = path.resolve(import.meta.dirname);
const baseUrl = process.env.PI_DESKTOP_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];

await page.addInitScript(() => window.localStorage.setItem("pi-theme", "dark"));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.goto(baseUrl, { waitUntil: "networkidle" });
await page.getByLabel("对话内容").fill("帮我分析当前项目的前端页面结构，并给出下一步优化建议。");
await page.getByRole("button", { name: "发送", exact: true }).click();
await page.locator(".qa-pair").waitFor();

const questionBox = await page.locator(".qa-question").first().boundingBox();
const answerBox = await page.locator(".qa-answer").first().boundingBox();
if (!questionBox || !answerBox || questionBox.x <= answerBox.x) {
  throw new Error("The user question is not positioned to the right of the Agent answer.");
}

await page.getByRole("button", { name: "复制用户输入" }).first().click();
await page.getByText("已复制").waitFor();
const answerBeforeRetry = await page.locator(".answer-content").first().textContent();
await page.getByRole("button", { name: "重新发送用户输入" }).first().click();
const answerAfterRetry = await page.locator(".answer-content").first().textContent();
if (answerBeforeRetry === answerAfterRetry) {
  throw new Error("Retry did not update the Agent answer.");
}

const compactComposer = await page.locator(".compact-composer").boundingBox();
if (!compactComposer || compactComposer.height >= 184) {
  throw new Error("The active conversation composer did not shrink.");
}

await page.getByLabel("继续对话").fill("优先从交互层级开始。 ");
await page.getByRole("button", { name: "发送", exact: true }).click();
if (await page.locator(".qa-pair").count() !== 2) {
  throw new Error("Follow-up message did not create a second Q&A pair.");
}

await page.screenshot({ path: path.join(outputDir, "implementation-05-active-conversation-dark.png") });

if (consoleErrors.length) throw new Error(`Browser console errors:\n${consoleErrors.join("\n")}`);
await browser.close();
