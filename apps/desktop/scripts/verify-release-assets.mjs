import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [mode, version, inputDirectory = "release"] = process.argv.slice(2);
if (!mode || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/verify-release-assets.mjs <linux-x64|win-x64|mac-x64|mac-arm64|mac-universal|all> <version> [directory]");
}

const expectedByMode = {
  "linux-x64": ["AppImage", "deb"],
  "win-x64": ["exe"],
  "mac-x64": ["dmg", "zip"],
  "mac-arm64": ["dmg", "zip"],
  "mac-universal": ["zip"],
};
const expectedName = (target, extension) => `Pi-Forge-${version}-${target}.${extension}`;
const allExpected = Object.entries(expectedByMode).flatMap(([target, extensions]) => extensions.map((extension) => expectedName(target, extension)));
const expected = mode === "all"
  ? allExpected
  : (expectedByMode[mode] ?? (() => { throw new Error(`Unknown validation mode: ${mode}`); })()).map((extension) => expectedName(mode, extension));

const directory = path.resolve(inputDirectory);
const entries = fs.readdirSync(directory, { withFileTypes: true });
const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
const packageExtensions = new Set([".AppImage", ".deb", ".dmg", ".exe", ".zip"]);
const packages = files.filter((file) => packageExtensions.has(path.extname(file)));
const updateManifests = files.filter((file) => /^latest.*\.ya?ml$/i.test(file));
const updateBlockmaps = files.filter((file) => /\.blockmap$/i.test(file));
const sboms = files.filter((file) => file.endsWith(".sbom.cdx.json"));
const expectedUpdateFiles = [
  "latest.yml",
  "latest-mac.yml",
  `Pi-Forge-${version}-win-x64.exe.blockmap`,
  `Pi-Forge-${version}-mac-universal.zip.blockmap`,
];
const expectedSboms = Object.keys(expectedByMode).map((target) => `Pi-Forge-${version}-${target}.sbom.cdx.json`);

if (mode === "all") {
  const actualUpdateFiles = [...updateManifests, ...updateBlockmaps];
  const missingUpdateFiles = expectedUpdateFiles.filter((file) => !actualUpdateFiles.includes(file));
  const unexpectedUpdateFiles = actualUpdateFiles.filter((file) => !expectedUpdateFiles.includes(file));
  const missingSboms = expectedSboms.filter((file) => !sboms.includes(file));
  if (missingUpdateFiles.length || unexpectedUpdateFiles.length || missingSboms.length || sboms.some((file) => !expectedSboms.includes(file))) {
    throw new Error(`Release security assets mismatch. Missing update files: ${missingUpdateFiles.join(", ") || "none"}; unexpected update files: ${unexpectedUpdateFiles.join(", ") || "none"}; missing SBOMs: ${missingSboms.join(", ") || "none"}.`);
  }
}
const missing = expected.filter((file) => !packages.includes(file));
const unexpected = packages.filter((file) => !expected.includes(file));
if (missing.length || unexpected.length || packages.length !== expected.length) {
  throw new Error(`Release artifact set mismatch. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
}
for (const file of expected) {
  const size = fs.statSync(path.join(directory, file)).size;
  if (size < 100_000) throw new Error(`Artifact is implausibly small (${size} bytes): ${file}`);
}

if (mode === "all") {
  const securedAssets = [...expected, ...expectedUpdateFiles, ...expectedSboms];
  const lines = securedAssets.slice().sort().map((file) => {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(directory, file))).digest("hex");
    return `${digest}  ${file}`;
  });
  const checksumFile = path.join(directory, "SHA256SUMS");
  fs.writeFileSync(checksumFile, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
  for (const line of lines) {
    const [digest, file] = line.split("  ");
    const actual = createHash("sha256").update(fs.readFileSync(path.join(directory, file))).digest("hex");
    if (actual !== digest) throw new Error(`Checksum verification failed immediately after generation: ${file}`);
  }
  console.log(`[release-assets] validated ${securedAssets.length} exact packages, update metadata, blockmaps, and SBOMs; wrote ${checksumFile}`);
} else {
  console.log(`[release-assets] validated ${expected.length} exact ${mode} artifact(s)`);
}
