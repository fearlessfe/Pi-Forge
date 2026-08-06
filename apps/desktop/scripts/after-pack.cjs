const asar = require("@electron/asar");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const plist = require("plist");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appBundle = fs.readdirSync(context.appOutDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appBundle) return;
  const resources = path.join(context.appOutDir, appBundle.name, "Contents", "Resources");
  const entryArchive = path.join(resources, "app.asar");
  if (!fs.existsSync(path.join(resources, "app-x64.asar")) || !fs.existsSync(path.join(resources, "app-arm64.asar"))) return;

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-universal-entry-"));
  const replacement = `${entryArchive}.replacement`;
  try {
    asar.extractAll(entryArchive, temporary);
    const packageFile = path.join(temporary, "package.json");
    const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    manifest.type = "commonjs";
    fs.writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(temporary, "index.js"), `"use strict";
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const appPath = app.getAppPath();
const architecture = process.arch === "arm64" ? "arm64" : "x64";
const architectureArchive = path.join(path.dirname(appPath), \`app-\${architecture}.asar\`);
const smokeResult = process.env.PI_DESKTOP_SMOKE_RESULT;
if (smokeResult) {
  fs.appendFileSync(\`\${smokeResult}.stages\`, \`\${new Date().toISOString()} universal-entry-started \${architecture}\\n\`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
app.setAppPath(architectureArchive);
process._archPath = architectureArchive;

void import(pathToFileURL(path.join(
  architectureArchive,
  "dist-electron/electron/bootstrap.js",
)).href).catch((error) => {
  console.error("Architecture-specific application entry failed to load:", error);
  app.exit(1);
});
`);
    await asar.createPackage(temporary, replacement);
    fs.renameSync(replacement, entryArchive);

    const infoPlistFile = path.join(context.appOutDir, appBundle.name, "Contents", "Info.plist");
    const infoPlist = plist.parse(fs.readFileSync(infoPlistFile, "utf8"));
    const integrity = infoPlist.ElectronAsarIntegrity;
    if (!integrity || typeof integrity !== "object" || !integrity["Resources/app.asar"]) {
      throw new Error("Universal app is missing the expected app.asar integrity entry");
    }
    integrity["Resources/app.asar"] = {
      algorithm: "SHA256",
      hash: crypto.createHash("sha256").update(asar.getRawHeader(entryArchive).headerString).digest("hex"),
    };
    fs.writeFileSync(infoPlistFile, plist.build(infoPlist));
  } finally {
    fs.rmSync(replacement, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};
