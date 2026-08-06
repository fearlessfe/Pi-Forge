import { describe, expect, it } from "vitest";
import { unpackedAsarPath } from "./asar-path.js";

describe("unpackedAsarPath", () => {
  it("maps regular, universal split, and node_modules ASAR paths", () => {
    expect(unpackedAsarPath("/Pi Forge.app/Contents/Resources/app.asar/node_modules/node-pty/index.js"))
      .toBe("/Pi Forge.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/index.js");
    expect(unpackedAsarPath("C:\\Pi Forge\\resources\\app-arm64.asar\\node_modules\\node-pty\\index.js"))
      .toBe("C:\\Pi Forge\\resources\\app-arm64.asar.unpacked\\node_modules\\node-pty\\index.js");
    expect(unpackedAsarPath("/resources/node_modules.asar/node-pty/index.js"))
      .toBe("/resources/node_modules.asar.unpacked/node-pty/index.js");
  });
});
