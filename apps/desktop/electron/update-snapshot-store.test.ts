import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateSnapshotStore } from "./update-snapshot-store.js";

const directories: string[] = [];
function temporary(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-update-${name}-`));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("UpdateSnapshotStore", () => {
  it("creates an integrity-checked state snapshot and restores it to isolated roots", () => {
    const source = temporary("source");
    const home = temporary("home");
    const snapshots = temporary("snapshots");
    fs.writeFileSync(path.join(source, "settings.json"), "settings-v1");
    fs.mkdirSync(path.join(home, "sessions"));
    fs.writeFileSync(path.join(home, "sessions", "conversation.jsonl"), "turn-v1");
    fs.mkdirSync(path.join(source, "Cache"));
    fs.writeFileSync(path.join(source, "Cache", "ignored"), "cache");
    const store = new UpdateSnapshotStore(snapshots, [
      { name: "user-data", path: source },
      { name: "pi-home", path: home },
    ]);

    const snapshot = store.create("1.2.3+build.7");
    expect(snapshot.appVersion).toBe("1.2.3+build.7");
    expect(snapshot.files.map((file) => `${file.root}/${file.path}`)).toEqual([
      "pi-home/sessions/conversation.jsonl",
      "user-data/settings.json",
    ]);

    const restoredUserData = temporary("restored-user-data");
    const restoredHome = temporary("restored-home");
    store.restoreTo(snapshot.id, { "user-data": restoredUserData, "pi-home": restoredHome });
    expect(fs.readFileSync(path.join(restoredUserData, "settings.json"), "utf8")).toBe("settings-v1");
    expect(fs.readFileSync(path.join(restoredHome, "sessions", "conversation.jsonl"), "utf8")).toBe("turn-v1");
  });

  it("rejects tampered snapshots and retains only the newest two", () => {
    const source = temporary("tamper-source");
    const snapshots = temporary("tamper-snapshots");
    fs.writeFileSync(path.join(source, "state.json"), "one");
    const store = new UpdateSnapshotStore(snapshots, [{ name: "user-data", path: source }], 2);
    const first = store.create("1.0.0");
    fs.writeFileSync(path.join(source, "state.json"), "two");
    store.create("1.0.1");
    fs.writeFileSync(path.join(source, "state.json"), "three");
    const third = store.create("1.0.2");
    expect(store.list()).toHaveLength(2);
    expect(fs.existsSync(path.join(snapshots, first.id))).toBe(false);

    fs.writeFileSync(path.join(snapshots, third.id, "roots", "user-data", "state.json"), "tampered");
    expect(() => store.restoreTo(third.id, { "user-data": temporary("tamper-target") })).toThrow("integrity check failed");
  });

  it("rejects cross-platform traversal and unknown roots in a tampered manifest", () => {
    const source = temporary("manifest-source");
    const snapshots = temporary("manifest-snapshots");
    fs.writeFileSync(path.join(source, "state.json"), "one");
    const store = new UpdateSnapshotStore(snapshots, [{ name: "user-data", path: source }]);
    const snapshot = store.create("1.0.0");
    const manifestFile = path.join(snapshots, snapshot.id, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.files[0].path = "..\\outside.json";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => store.restoreTo(snapshot.id, { "user-data": temporary("manifest-target") })).toThrow("Invalid update snapshot manifest");

    manifest.files[0].path = "state.json";
    manifest.files[0].root = "unknown-root";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => store.restoreTo(snapshot.id, { "user-data": temporary("manifest-target-root") })).toThrow("Invalid update snapshot manifest");
  });
});
