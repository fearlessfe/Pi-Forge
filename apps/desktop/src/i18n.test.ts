import { describe, expect, it } from "vitest";
import { enUS, translateMessage, zhCN } from "./i18n";

const componentSources = Object.values(import.meta.glob("./**/*.tsx", {
  eager: true,
  import: "default",
  query: "?raw",
})) as string[];

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

  it("keeps locale resources structurally aligned", () => {
    expect(Object.keys(zhCN)).toEqual(Object.keys(enUS));
  });

  it("fully translates plugin details without Chinese fallback text", () => {
    const keys = [
      "查看 {name} 详情",
      "查看详情",
      "月下载",
      "更新时间",
      "来源",
      "完整性摘要",
      "资源清单",
      "注册表未提供完整性摘要",
      "低风险",
      "中风险",
      "高风险",
      "已阻止",
      "关闭",
      "你可以用它来",
      "怎么使用",
      "调用插件新增的工具或命令，扩展 Agent 可以执行的操作。",
      "让 Agent 按插件内置的专业流程处理相关任务。",
      "使用插件提供的预设提示词，更快启动重复性任务。",
      "点击下方安装，Pi 会校验插件并重新加载当前 Agent 会话。",
      "在对话中直接描述你的目标；Agent 会在适用时调用这个插件的能力。",
      "如果能力没有立即出现，请新建一个 Agent 会话后再试。",
    ];

    for (const key of keys) {
      expect(translateMessage("en-US", key, { name: "demo" })).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it("defines English resources for every direct interface translation key", () => {
    const directCall = /(?<![\w])t\(\s*"((?:\\.|[^"\\])*)"/gu;
    const keys = componentSources.flatMap((source) => (
      [...source.matchAll(directCall)].map((match) => JSON.parse(`"${match[1]}"`) as string)
    ));
    const missing = [...new Set(keys)].filter((key) => !(key in enUS)).sort();

    expect(missing).toEqual([]);
  });
});
