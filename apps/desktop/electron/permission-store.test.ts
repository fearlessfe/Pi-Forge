import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionStore } from "./permission-store.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permission-store-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("PermissionStore", () => {
  it("defaults to balanced mode and persists strict mode", () => {
    const directory = temporaryDirectory();
    const store = new PermissionStore(directory);

    expect(store.get()).toEqual({ mode: "balanced" });
    expect(store.save({ mode: "strict" })).toEqual({ mode: "strict" });
    expect(new PermissionStore(directory).get()).toEqual({ mode: "strict" });
  });

  it("falls back safely when the stored file is invalid", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "permissions.json"), JSON.stringify({ mode: "unrestricted" }));
    expect(new PermissionStore(directory).get()).toEqual({ mode: "balanced" });
  });
});
