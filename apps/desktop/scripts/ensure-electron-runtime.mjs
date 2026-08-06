import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
  throw new Error("Electron runtime is unavailable after dependency installation.");
}

console.log(`[ensure-electron-runtime] ${electronPath}`);
