import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appRoot = path.resolve(process.argv[2] ?? "release-smoke");
const timeoutMs = Number(process.env.PI_DESKTOP_SMOKE_TIMEOUT_MS ?? 120_000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) throw new Error("PI_DESKTOP_SMOKE_TIMEOUT_MS must be at least 1000ms");

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function findExecutable() {
  const files = walk(appRoot);
  const isMacBundleExecutable = (file) => (
    path.basename(file) === "pi-forge"
    && path.basename(path.dirname(file)) === "MacOS"
    && path.basename(path.dirname(path.dirname(file))) === "Contents"
    && path.extname(path.dirname(path.dirname(path.dirname(file)))).toLowerCase() === ".app"
  );
  const candidates = process.platform === "win32"
    ? files.filter((file) => path.basename(file).toLowerCase() === "pi-forge.exe")
    : process.platform === "darwin"
      ? files.filter(isMacBundleExecutable)
      : files.filter((file) => path.basename(file) === "pi-forge" && file.includes("linux-unpacked"));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one packaged executable below ${appRoot}; found ${candidates.length}: ${candidates.join(", ")}`);
  }
  return candidates[0];
}

const executable = findExecutable();
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-forge-packaged-smoke-"));
const resultFile = path.join(temporaryDirectory, "result.json");
const userData = path.join(temporaryDirectory, "user-data");
const piDesktopHome = path.join(temporaryDirectory, "pi-desktop-home");
const command = process.platform === "linux" ? "xvfb-run" : executable;
const args = process.platform === "linux" ? ["-a", executable] : [];
console.log(`[packaged-smoke] launching ${executable}`);

const child = spawn(command, args, {
  cwd: path.dirname(executable),
  env: {
    ...process.env,
    PI_DESKTOP_DISABLE_VIBRANCY: "1",
    PI_DESKTOP_SMOKE_RESULT: resultFile,
    PI_DESKTOP_USER_DATA: userData,
    PI_DESKTOP_HOME: piDesktopHome,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let spawnError;
const captureOutput = (chunk) => { output = `${output}${chunk}`.slice(-8_000); };
child.stdout.on("data", captureOutput);
child.stderr.on("data", captureOutput);
child.once("error", (error) => { spawnError = error; });

async function waitForExit(waitMs) {
  if (child.exitCode !== null) return true;
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, waitMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

try {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(resultFile) && child.exitCode === null && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (spawnError) throw spawnError;
  if (!fs.existsSync(resultFile)) {
    throw new Error(child.exitCode === null
      ? `Timed out after ${timeoutMs}ms`
      : `Packaged app exited before reporting readiness (exit ${child.exitCode})`);
  }
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  if (!result.ok || !result.checks?.preload || !result.checks?.ipc || !result.checks?.runtime || !result.checks?.terminal) {
    throw new Error(`Self-check failed: ${JSON.stringify(result)}`);
  }
  if (!await waitForExit(10_000)) throw new Error("Packaged app reported readiness but did not shut down cleanly");
  if (child.exitCode !== 0) throw new Error(`Packaged app exited with code ${child.exitCode} after reporting readiness`);
  console.log(`[packaged-smoke] passed version ${result.version}: preload, IPC, Runtime handshake, node-pty`);
} catch (error) {
  console.error(`[packaged-smoke] ${error instanceof Error ? error.message : String(error)}\n${output}`);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await waitForExit(2_000);
  if (child.exitCode === null) child.kill("SIGKILL");
  await waitForExit(2_000);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
