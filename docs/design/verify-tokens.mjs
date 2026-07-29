/**
 * Token 工具类持久验证 —— docs/design-refresh-apple.md 3.2/3.3（D0）。
 *
 * 用 tailwindcss 的 Node API compile() 编译 apps/desktop/src/styles.css，
 * 对候选类清单跑 build()，断言 token v2 对应的工具类全部生成；
 * 有缺失即以非零码退出。候选清单随 token 契约扩充时同步追加。
 *
 * 用法：
 *   node docs/design/verify-tokens.mjs
 *   或 pnpm verify:tokens
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const appDir = path.join(repoRoot, "apps/desktop");
const stylesPath = path.join(appDir, "src/styles.css");

// tailwindcss 是 apps/desktop 的依赖，须在该目录上下文解析（root 未直接依赖）。
const require = createRequire(path.join(appDir, "package.json"));
const { compile } = require("tailwindcss");
const tailwindEntry = require.resolve("tailwindcss/index.css");

/** 候选类清单：token v2 契约要求必须生成工具类的最小集合。 */
const candidates = [
  // 语义色 / 材质 / 阴影（@theme inline，随主题翻转）
  "bg-bg", "bg-bg-grouped", "bg-bg-grouped-2",
  "bg-fill", "bg-fill-2", "bg-fill-3",
  "text-label", "text-label-2", "text-label-3", "text-label-4",
  "border-separator",
  "bg-accent", "text-accent-ink",
  "bg-blue", "bg-orange", "bg-red", "bg-green", "bg-knob",
  "bg-accent/8", "bg-accent/16", "bg-accent/32",
  "bg-material-sidebar", "bg-material-chrome",
  "shadow-1", "shadow-2", "shadow-3",
  // 圆角 / 字体 / 字号（@theme 静态）
  "rounded-sm", "rounded-md", "rounded-lg",
  "font-sans", "font-mono",
  "text-mini", "text-caption", "text-callout", "text-body",
  "text-headline", "text-title", "text-large-title",
  // 间距命名契约：tight/base/loose/card/panel/section + pad-control + control-* 高度档
  "p-tight", "p-base", "p-loose", "p-card", "p-panel", "p-section",
  "pad-control",
  "gap-tight", "gap-loose",
  "h-control-sm", "h-control-md", "h-control-lg",
  // 动效
  "ease-apple", "duration-150", "duration-250",
  "ring-accent/32",
];

/** CSS 标识符转义（Node 无 CSS.escape）：类名中的 / 等字符在产物选择器里带反斜杠。 */
const escapeIdent = (cls) => cls.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

const { build } = await compile(fs.readFileSync(stylesPath, "utf8"), {
  base: appDir,
  loadStylesheet: async (id, base) => {
    const resolved = id === "tailwindcss" ? tailwindEntry : path.resolve(base, id);
    return { path: resolved, base: path.dirname(resolved), content: await fs.promises.readFile(resolved, "utf8") };
  },
});

const output = build(candidates);
const missing = candidates.filter((cls) => !output.includes(`.${escapeIdent(cls)}`));

if (missing.length) {
  console.error(`[verify-tokens] 失败：${missing.length} 个候选工具类未生成：\n  ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`[verify-tokens] 通过：${candidates.length} 个候选工具类全部生成。`);
