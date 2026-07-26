import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// node-pty only builds spawn-helper on macOS. Linux loads pty.node directly,
// while Windows uses ConPTY/winpty executables from its platform prebuild.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("node-pty");
  const root = path.dirname(path.dirname(entry));
  const candidates = [
    path.join(root, "build", "Release"),
    path.join(root, "build", "Debug"),
    path.join(root, "prebuilds", `${process.platform}-${process.arch}`),
  ];
  const directory = candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, "pty.node"))
    && fs.existsSync(path.join(candidate, "spawn-helper"))
  ));
  if (!directory) throw new Error("node-pty spawn-helper was not found");
  const helper = path.join(directory, "spawn-helper");
  const mode = fs.statSync(helper).mode;
  if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o111);
}
