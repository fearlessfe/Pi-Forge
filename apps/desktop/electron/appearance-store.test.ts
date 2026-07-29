import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppearanceStore } from "./appearance-store.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-appearance-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("AppearanceStore", () => {
  it("defaults to dark when no theme has been persisted", () => {
    expect(new AppearanceStore(temporaryDirectory()).get()).toBe("dark");
  });

  it("persists the last theme across restarts so the window can restore its background", () => {
    const directory = temporaryDirectory();
    new AppearanceStore(directory).save("light");

    expect(new AppearanceStore(directory).get()).toBe("light");
    expect(JSON.parse(fs.readFileSync(path.join(directory, "appearance.json"), "utf8"))).toEqual({ version: 1, theme: "light" });
  });

  it("overwrites the previous theme on every save", () => {
    const directory = temporaryDirectory();
    const store = new AppearanceStore(directory);
    store.save("light");
    store.save("dark");

    expect(new AppearanceStore(directory).get()).toBe("dark");
  });

  it("falls back to dark on malformed or unexpected files instead of preventing startup", () => {
    const broken = temporaryDirectory();
    fs.writeFileSync(path.join(broken, "appearance.json"), "{broken", "utf8");
    expect(new AppearanceStore(broken).get()).toBe("dark");

    const unexpected = temporaryDirectory();
    fs.writeFileSync(path.join(unexpected, "appearance.json"), JSON.stringify({ version: 1, theme: "solarized" }), "utf8");
    expect(new AppearanceStore(unexpected).get()).toBe("dark");
  });
});
