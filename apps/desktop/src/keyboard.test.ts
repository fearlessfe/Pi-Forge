import { describe, expect, it } from "vitest";
import { isPrimaryShortcut, shouldSubmitOnEnter } from "./keyboard.js";

describe("isPrimaryShortcut", () => {
  it.each([
    { metaKey: true, ctrlKey: false },
    { metaKey: false, ctrlKey: true },
  ])("accepts the platform primary modifier", ({ metaKey, ctrlKey }) => {
    expect(isPrimaryShortcut({ key: "K", metaKey, ctrlKey, altKey: false, shiftKey: false }, "k")).toBe(true);
  });

  it("rejects modified and unrelated key combinations", () => {
    expect(isPrimaryShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, "k")).toBe(false);
    expect(isPrimaryShortcut({ key: "k", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, "k")).toBe(false);
    expect(isPrimaryShortcut({ key: "n", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, "k")).toBe(false);
  });
});

describe("shouldSubmitOnEnter", () => {
  it("submits on plain Enter", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("keeps Shift+Enter as a newline", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });
});
