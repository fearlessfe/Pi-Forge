import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [inputDirectory = "release"] = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("macOS signature verification must run on macOS.");
const release = path.resolve(inputDirectory);
const appBundle = fs.readdirSync(release, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
  .flatMap((entry) => {
    const directory = path.join(release, entry.name);
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory() && candidate.name.endsWith(".app"))
      .map((candidate) => path.join(directory, candidate.name));
  })
  .find((entry) => fs.existsSync(entry));
if (!appBundle) throw new Error("Cannot locate packaged Pi Forge application bundle.");
const dmg = fs.readdirSync(release).map((entry) => path.join(release, entry)).find((entry) => entry.endsWith(".dmg"));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
const details = run("codesign", ["-dv", "--verbose=4", appBundle]);
if (!/TeamIdentifier=[A-Z0-9]+/.test(details) || !/flags=.*runtime/.test(details)) {
  throw new Error("Signed app is missing a TeamIdentifier or hardened-runtime flag.");
}
const entitlements = run("codesign", ["-d", "--entitlements", ":-", appBundle]);
if (!entitlements.includes("com.apple.security.cs.allow-jit") || entitlements.includes("com.apple.security.cs.disable-library-validation")) {
  throw new Error("App entitlements are missing JIT support or unnecessarily disable library validation.");
}
run("spctl", ["--assess", "--type", "execute", "--verbose=4", appBundle]);
run("xcrun", ["stapler", "validate", appBundle]);
if (dmg) run("xcrun", ["stapler", "validate", dmg]);
console.log(`[release-signature] verified Developer ID, hardened runtime, Gatekeeper, and notarization for ${appBundle}`);
