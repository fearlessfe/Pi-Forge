import { app } from "electron";
import fs from "node:fs";

const smokeResult = process.env.PI_DESKTOP_SMOKE_RESULT;
const stageFile = smokeResult ? `${smokeResult}.stages` : undefined;

function stage(value: string): void {
  if (!stageFile) return;
  fs.appendFileSync(stageFile, `${new Date().toISOString()} ${value}\n`, { encoding: "utf8", mode: 0o600 });
}

stage("bootstrap-started");
void import("./main.js").then(() => {
  stage("main-module-loaded");
}).catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  stage(`main-module-failed ${detail}`);
  console.error("Application module failed to load:", detail);
  app.exit(1);
});
