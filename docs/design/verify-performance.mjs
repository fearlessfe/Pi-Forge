import fs from "node:fs";
import path from "node:path";

process.env.VITE_PERFORMANCE_PROFILE = "1";
process.env.PI_DESKTOP_VERIFY_PORT ??= "4183";
const {
  BASE_URL,
  chromium,
  ensureDevServer,
  installMockBridge,
  installSignalHandlers,
  killServer,
  repoRoot,
} = await import("./verify-lane-lib.mjs");

const budgets = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps/desktop/performance-budgets.json"), "utf8"));
if (budgets.version !== 1) throw new Error(`Unsupported performance budget version: ${budgets.version}`);
const outputRoot = path.resolve(process.env.PI_PERFORMANCE_OUTPUT_DIR ?? path.join(repoRoot, "artifacts/performance"));
fs.mkdirSync(outputRoot, { recursive: true });

let serverProcess = null;
let browser;
let page;
let cdp;
let traceStarted = false;
let fatalError;
const traceEvents = [];
const consoleErrors = [];
let reactCommits = [];
let summary;
installSignalHandlers(() => serverProcess);

try {
  serverProcess = await ensureDevServer();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.addInitScript(installMockBridge, { performanceConversation: true });
  await page.addInitScript(() => window.localStorage.setItem("pi-theme", "dark"));

  cdp = await page.context().newCDPSession(page);
  cdp.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
  await cdp.send("Performance.enable");
  await cdp.send("Tracing.start", {
    categories: [
      "devtools.timeline",
      "blink.user_timing",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-v8.cpu_profiler",
    ].join(","),
    options: "sampling-frequency=10000",
    transferMode: "ReportEvents",
  });
  traceStarted = true;

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "今天想一起做什么？" }).waitFor();
  await page.locator(".material-sidebar").getByRole("button", { name: /^排查验收车道截图脚本/ }).click();
  const tail = page.locator('[data-virtual-turn-id="perf-turn-99"]');
  await tail.locator(".markdown-content").waitFor();
  const fixture = await page.evaluate(() => window.piVerify?.fixture);
  if (fixture?.turns !== 100 || fixture.lastMessageCharacters !== 50_000 || fixture.toolActivities !== 20) {
    throw new Error(`Performance fixture shape is invalid: ${JSON.stringify(fixture)}`);
  }
  const renderedCharacters = (await tail.locator(".markdown-content").textContent())?.length ?? 0;
  if (renderedCharacters < 49_900) throw new Error(`Performance fixture rendered only ${renderedCharacters} Markdown characters.`);
  await tail.getByRole("button", { name: /调用了多个工具/ }).click();
  const toolActivities = await tail.locator('[data-state="open"]').getByRole("button").count();
  if (toolActivities < 20) throw new Error(`Performance fixture rendered only ${toolActivities} tool activities.`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const mountedTurns = await page.locator("[data-virtual-turn-id]").count();
  const navigationMs = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.duration ?? Number.POSITIVE_INFINITY);
  reactCommits = await page.evaluate(() => window.piReactProfile ?? []);
  const performanceMetrics = await cdp.send("Performance.getMetrics");
  const maxReactCommitMs = Math.max(0, ...reactCommits.map((commit) => commit.actualDuration));
  const totalReactCommitMs = reactCommits.reduce((total, commit) => total + commit.actualDuration, 0);
  summary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    budgets: budgets.renderer,
    navigationMs,
    mountedTurns,
    reactCommitCount: reactCommits.length,
    maxReactCommitMs,
    totalReactCommitMs,
    chromiumMetrics: Object.fromEntries(performanceMetrics.metrics.map(({ name, value }) => [name, value])),
  };

  const failures = [];
  if (navigationMs > budgets.renderer.navigationMs) failures.push(`navigation ${navigationMs.toFixed(1)}ms > ${budgets.renderer.navigationMs}ms`);
  if (mountedTurns > budgets.renderer.maxMountedTurns) failures.push(`mounted turns ${mountedTurns} > ${budgets.renderer.maxMountedTurns}`);
  if (reactCommits.length === 0) failures.push("React Profiler produced no commits");
  if (maxReactCommitMs > budgets.renderer.maxReactCommitMs) failures.push(`React commit ${maxReactCommitMs.toFixed(1)}ms > ${budgets.renderer.maxReactCommitMs}ms`);
  if (totalReactCommitMs > budgets.renderer.totalReactCommitMs) failures.push(`React total ${totalReactCommitMs.toFixed(1)}ms > ${budgets.renderer.totalReactCommitMs}ms`);
  if (consoleErrors.length > 0) failures.push(`console/page errors: ${consoleErrors.join(" | ")}`);
  if (failures.length > 0) throw new Error(`Renderer performance budget exceeded: ${failures.join("; ")}`);
} catch (error) {
  fatalError = error;
} finally {
  if (traceStarted && cdp) {
    const completed = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end").catch(() => {});
    await Promise.race([completed, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
  if (summary) {
    const mainThreadTasks = traceEvents
      .filter((event) => event.ph === "X" && event.name === "RunTask" && Number.isFinite(event.dur))
      .map((event) => event.dur / 1000);
    summary.maxMainThreadTaskMs = Math.max(0, ...mainThreadTasks);
    if (summary.maxMainThreadTaskMs > budgets.renderer.maxMainThreadTaskMs && !fatalError) {
      fatalError = new Error(`Renderer performance budget exceeded: main-thread task ${summary.maxMainThreadTaskMs.toFixed(1)}ms > ${budgets.renderer.maxMainThreadTaskMs}ms`);
    }
  }
  fs.writeFileSync(path.join(outputRoot, "chromium-trace.json"), `${JSON.stringify({ traceEvents })}\n`);
  fs.writeFileSync(path.join(outputRoot, "react-profile.json"), `${JSON.stringify({ version: 1, commits: reactCommits }, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, "renderer-summary.json"), `${JSON.stringify({ ...summary, consoleErrors }, null, 2)}\n`);
  await browser?.close();
  await killServer(serverProcess);
}

if (fatalError) throw fatalError;
console.log(`[performance] renderer passed: navigation ${summary.navigationMs.toFixed(1)}ms, React max ${summary.maxReactCommitMs.toFixed(1)}ms, main-thread max ${summary.maxMainThreadTaskMs.toFixed(1)}ms`);
console.log(`[performance] trace and profiles: ${outputRoot}`);
