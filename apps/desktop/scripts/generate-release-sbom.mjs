import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";

const [mode, version, inputDirectory = "release"] = process.argv.slice(2);
const modes = new Set(["linux-x64", "win-x64", "mac-x64", "mac-arm64", "mac-universal"]);
if (!modes.has(mode) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  throw new Error("Usage: node scripts/generate-release-sbom.mjs <linux-x64|win-x64|mac-x64|mac-arm64|mac-universal> <version> [directory]");
}

const release = path.resolve(inputDirectory);
const macDirectories = mode === "mac-universal" ? ["mac-universal"] : mode === "mac-arm64" ? ["mac-arm64"] : ["mac", "mac-x64"];
const resources = mode.startsWith("mac-")
  ? macDirectories.flatMap((name) => {
    const directory = path.join(release, name);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory() && candidate.name.endsWith(".app"))
      .map((candidate) => path.join(directory, candidate.name, "Contents", "Resources"));
  })[0]
  : path.join(release, mode.startsWith("win-") ? "win-unpacked" : "linux-unpacked", "resources");
if (!resources || !fs.existsSync(resources)) throw new Error(`Cannot locate packaged resources for ${mode}.`);
const archives = fs.readdirSync(resources)
  .filter((name) => /^app(?:-(?:x64|arm64))?\.asar$/.test(name))
  .map((name) => path.join(resources, name))
  .sort();
if (archives.length === 0) throw new Error(`Cannot locate packaged app.asar for ${mode}.`);

function packageUrl(name, packageVersion) {
  const packagePath = name.startsWith("@")
    ? name.split("/").map((segment) => encodeURIComponent(segment)).join("/")
    : encodeURIComponent(name);
  return `pkg:npm/${packagePath}@${encodeURIComponent(packageVersion)}`;
}

const packageMap = new Map();
for (const archive of archives) {
  const archiveEntries = listPackage(archive, { isPack: false }).map((entry) => entry.replace(/^\//, ""));
  for (const entry of archiveEntries.filter((candidate) => /^node_modules\/(?:@[^/]+\/[^/]+|[^/]+)\/package\.json$/.test(candidate))) {
    try {
      const value = JSON.parse(extractFile(archive, entry).toString("utf8"));
      if (typeof value.name !== "string" || typeof value.version !== "string") continue;
      const key = `${value.name}@${value.version}`;
      const existing = packageMap.get(key);
      if (existing) {
        existing.paths.add(`${path.basename(archive)}:${entry}`);
      } else {
        packageMap.set(key, { name: value.name, version: value.version, license: value.license, paths: new Set([`${path.basename(archive)}:${entry}`]) });
      }
    } catch {
      // Malformed package metadata is omitted; required runtime packages are checked below.
    }
  }
}
const packages = [...packageMap.values()].map((value) => ({
  type: "library",
  name: value.name,
  version: value.version,
  ...(typeof value.license === "string" ? { licenses: [{ license: { name: value.license } }] } : {}),
  purl: packageUrl(value.name, value.version),
  properties: [{ name: "pi-forge:asar-paths", value: [...value.paths].sort().join(",") }],
})).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

for (const required of ["node-pty", "@earendil-works/pi-coding-agent"]) {
  if (!packages.some((component) => component.name === required)) throw new Error(`Packaged SBOM is missing required runtime component: ${required}`);
}
if (packages.some((component) => component.name === "vitest")) throw new Error("Packaged SBOM unexpectedly contains a development-only dependency: vitest");

const digestHash = createHash("sha256");
for (const archive of archives) digestHash.update(path.basename(archive)).update("\0").update(fs.readFileSync(archive));
const digest = digestHash.digest("hex");
const serial = createHash("sha256").update(`${mode}:${version}:${digest}`).digest("hex");
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-4${serial.slice(13, 16)}-a${serial.slice(17, 20)}-${serial.slice(20, 32)}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: "Pi Forge",
      version,
      properties: [
        { name: "pi-forge:target", value: mode },
        { name: "pi-forge:app-asar-sha256", value: digest },
      ],
    },
  },
  components: packages,
};
const output = path.join(release, `Pi-Forge-${version}-${mode}.sbom.cdx.json`);
fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o644 });
console.log(`[release-sbom] wrote ${output} with ${packages.length} packaged components`);
