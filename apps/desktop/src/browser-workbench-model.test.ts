import { describe, expect, it } from "vitest";
import { browserClearDataInput, browserModeDescription, initialBrowserState, nextBrowserMode } from "./browser-workbench-model";

describe("browser workbench model", () => {
  it("starts in the persistent browser partition", () => {
    expect(initialBrowserState).toMatchObject({ mode: "persistent", url: "about:blank" });
  });

  it("toggles modes without accepting an arbitrary partition", () => {
    expect(nextBrowserMode("persistent")).toBe("private");
    expect(nextBrowserMode("private")).toBe("persistent");
  });

  it("scopes clear requests to a known mode and data type", () => {
    expect(browserClearDataInput("private", "storage")).toEqual({ mode: "private", dataTypes: ["storage"] });
  });

  it("describes the different retention boundaries", () => {
    expect(browserModeDescription("persistent")).toContain("保留");
    expect(browserModeDescription("private")).toContain("自动清除");
  });
});
