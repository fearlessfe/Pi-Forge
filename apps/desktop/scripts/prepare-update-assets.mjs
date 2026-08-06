import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [mode, version, inputDirectory = "release"] = process.argv.slice(2);
if (!mode || !version) throw new Error("Usage: node scripts/prepare-update-assets.mjs <mode> <version> [directory]");
const directory = path.resolve(inputDirectory);
const entries = fs.readdirSync(directory).filter((name) => /^latest.*\.ya?ml$/i.test(name) || name.endsWith(".blockmap"));
const keep = mode === "win-x64"
  ? new Set(["latest.yml", `Pi-Forge-${version}-win-x64.exe.blockmap`])
  : mode === "mac-universal"
    ? new Set(["latest-mac.yml", `Pi-Forge-${version}-mac-universal.zip.blockmap`])
    : new Set();
for (const entry of entries) {
  if (!keep.has(entry)) fs.rmSync(path.join(directory, entry), { force: true });
}
const remaining = fs.readdirSync(directory).filter((name) => /^latest.*\.ya?ml$/i.test(name) || name.endsWith(".blockmap"));
if (remaining.some((name) => !keep.has(name)) || remaining.length !== keep.size) {
  throw new Error(`Update metadata mismatch for ${mode}. Expected ${[...keep].join(", ") || "none"}; got ${remaining.join(", ") || "none"}.`);
}
for (const manifestName of [...keep].filter((name) => name.endsWith(".yml"))) {
  const manifest = fs.readFileSync(path.join(directory, manifestName), "utf8");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^version:\\s*${escapedVersion}\\s*$`, "m").test(manifest)) throw new Error(`${manifestName} has the wrong version.`);
  const urls = [...manifest.matchAll(/^\s*-?\s*url:\s*([^\s]+)\s*$/gm)].map((match) => path.basename(match[1]));
  if (urls.length !== 1 || !keep.has(`${urls[0]}.blockmap`) || !fs.existsSync(path.join(directory, urls[0]))) {
    throw new Error(`${manifestName} must reference exactly one retained signed update payload.`);
  }
  const sha512 = [...manifest.matchAll(/^\s*sha512:\s*([^\s]+)\s*$/gm)].map((match) => match[1]);
  const digest = createHash("sha512").update(fs.readFileSync(path.join(directory, urls[0]))).digest("base64");
  if (!sha512.includes(digest)) throw new Error(`${manifestName} SHA-512 does not match ${urls[0]}.`);
}
console.log(`[release-update] retained ${remaining.join(", ") || "no update metadata"} for ${mode}`);
