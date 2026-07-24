import { describe, expect, it } from "vitest";
import { translateMessage } from "./i18n";

describe("translateMessage", () => {
  it("translates known interface text to English", () => {
    expect(translateMessage("en-US", "设置")).toBe("Settings");
  });

  it("interpolates dynamic values in either language", () => {
    expect(translateMessage("en-US", "在 {name} 中开始新对话", { name: "demo" })).toBe("Start a new chat in demo");
    expect(translateMessage("zh-CN", "在 {name} 中开始新对话", { name: "示例" })).toBe("在 示例 中开始新对话");
  });

  it("falls back to source text when a translation is missing", () => {
    expect(translateMessage("en-US", "Untranslated provider message")).toBe("Untranslated provider message");
  });
});
