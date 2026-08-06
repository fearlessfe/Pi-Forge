import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const appRootArgument = process.argv.slice(2).find((argument) => argument !== "--");
const appRoot = path.resolve(appRootArgument ?? path.join(desktopRoot, "release"));
const budgets = JSON.parse(fs.readFileSync(path.join(desktopRoot, "performance-budgets.json"), "utf8"));
if (budgets.version !== 1) throw new Error(`Unsupported performance budget version: ${budgets.version}`);
const outputRoot = path.resolve(process.env.PI_PERFORMANCE_OUTPUT_DIR ?? path.join(desktopRoot, "../../artifacts/performance"));
fs.mkdirSync(outputRoot, { recursive: true });

async function sample(index) {
  const reportFile = path.join(outputRoot, `startup-sample-${index + 1}.json`);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "smoke-packaged.mjs"), appRoot], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      PI_DESKTOP_SMOKE_REPORT: reportFile,
      PI_DESKTOP_SMOKE_TIMEOUT_MS: String(Math.max(10_000, budgets.startup.maxReadyMs * 2)),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => { output = `${output}${chunk}`.slice(-12_000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  if (exitCode !== 0 || !fs.existsSync(reportFile)) {
    throw new Error(`Startup sample ${index + 1} failed (exit ${exitCode}).\n${output}`);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  console.log(`[startup-budget] sample ${index + 1}: ${report.readyMs.toFixed(1)}ms`);
  return report;
}

const samples = [];
for (let index = 0; index < budgets.startup.samples; index += 1) samples.push(await sample(index));
const sorted = samples.map(({ readyMs }) => readyMs).sort((left, right) => left - right);
const medianReadyMs = sorted[Math.floor(sorted.length / 2)];
const maxReadyMs = sorted.at(-1);
const summary = {
  version: 1,
  generatedAt: new Date().toISOString(),
  appRoot,
  budgets: budgets.startup,
  medianReadyMs,
  maxReadyMs,
  samples: samples.map(({ readyMs, executable, version }) => ({ readyMs, executable, version })),
};
fs.writeFileSync(path.join(outputRoot, "startup-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const failures = [];
if (medianReadyMs > budgets.startup.medianReadyMs) failures.push(`median ${medianReadyMs.toFixed(1)}ms > ${budgets.startup.medianReadyMs}ms`);
if (maxReadyMs > budgets.startup.maxReadyMs) failures.push(`max ${maxReadyMs.toFixed(1)}ms > ${budgets.startup.maxReadyMs}ms`);
if (failures.length > 0) throw new Error(`Packaged startup budget exceeded: ${failures.join("; ")}`);
console.log(`[startup-budget] passed: median ${medianReadyMs.toFixed(1)}ms, max ${maxReadyMs.toFixed(1)}ms`);
