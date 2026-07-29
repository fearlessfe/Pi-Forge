/**
 * 黄金图回归门禁（pixelmatch 像素对比）—— docs/design-refresh-apple.md 第六节验收矩阵第 1 项。
 *
 * 把 docs/design/shots/（verify:renderer / verify:a11y / verify:electron 产出的场景截图）
 * 与 docs/design/golden/ 基准逐图做像素对比：
 *   - pixelmatch threshold 0.15（吸收抗锯齿级微差）；
 *   - 允许差异像素比例 ≤ 2%（吸收时间戳、终端光标等动态内容）；
 *   - 超阈值时把 diff 图写到 shots/diff-<场景名>.png 并以非零码退出。
 *
 * 本脚本只比较，**不自动更新基准**——刻意保持"基准必须人工确认"的门禁语义：
 * 视觉变更有意为之时才人工把 shots/*.png 复制进 golden/。
 *
 * 用法：
 *   node docs/design/verify-golden.mjs
 *   或 pnpm verify:golden
 *   golden 缺失或为空时退出码 2，并提示先跑各车道再复制基准。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch").default ?? require("pixelmatch");

const designDir = import.meta.dirname;
const shotsDir = path.resolve(process.env.SHOTS_DIR ?? path.join(designDir, "shots"));
const goldenDir = path.resolve(process.env.GOLDEN_DIR ?? path.join(designDir, "golden"));

// 差异像素比例上限：2%（吸收动态内容，见文件头）。
const MAX_DIFF_RATIO = 0.02;
const PIXELMATCH_THRESHOLD = 0.15;

if (!fs.existsSync(goldenDir) || fs.readdirSync(goldenDir).filter((name) => name.endsWith(".png")).length === 0) {
  console.error(
    `[golden-lane] 基准目录 ${goldenDir} 缺失或为空。\n`
    + "请先运行 pnpm verify:renderer / verify:a11y / verify:electron 产出 shots，"
    + "人工确认截图符合设计契约后复制为基准：cp docs/design/shots/*.png docs/design/golden/。",
  );
  process.exit(2);
}
if (!fs.existsSync(shotsDir)) {
  console.error(`[golden-lane] 截图目录 ${shotsDir} 不存在，请先运行各验收车道产出截图。`);
  process.exit(2);
}

const baselines = fs.readdirSync(goldenDir).filter((name) => name.endsWith(".png")).sort();
const failures = [];
const missing = [];

for (const name of baselines) {
  const goldenPath = path.join(goldenDir, name);
  const shotPath = path.join(shotsDir, name);
  if (!fs.existsSync(shotPath)) {
    missing.push(name);
    continue;
  }
  const golden = PNG.sync.read(fs.readFileSync(goldenPath));
  const shot = PNG.sync.read(fs.readFileSync(shotPath));
  if (golden.width !== shot.width || golden.height !== shot.height) {
    failures.push(`${name}: 尺寸不一致（golden ${golden.width}x${golden.height} vs shot ${shot.width}x${shot.height}）`);
    continue;
  }
  const diff = new PNG({ width: golden.width, height: golden.height });
  const mismatched = pixelmatch(golden.data, shot.data, diff.data, golden.width, golden.height, {
    threshold: PIXELMATCH_THRESHOLD,
  });
  const ratio = mismatched / (golden.width * golden.height);
  if (ratio > MAX_DIFF_RATIO) {
    const diffPath = path.join(shotsDir, `diff-${name}`);
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    failures.push(`${name}: 差异像素 ${(ratio * 100).toFixed(2)}% > ${MAX_DIFF_RATIO * 100}%（diff 图：${diffPath}）`);
  } else {
    console.log(`[golden-lane] ${name}: 差异 ${(ratio * 100).toFixed(3)}%（≤ ${MAX_DIFF_RATIO * 100}%，通过）`);
  }
}

if (missing.length) {
  console.error(`[golden-lane] ${missing.length} 张基准缺少对应截图（先跑对应车道）：\n  ${missing.join("\n  ")}`);
}
if (failures.length) {
  console.error(`[golden-lane] ${failures.length} 张截图超出差异阈值：\n  ${failures.join("\n  ")}`);
}
if (missing.length || failures.length) {
  console.error("[golden-lane] 失败：视觉回归或截图缺失。若变更为有意为之，人工确认后更新 golden 基准。");
  process.exit(1);
}
console.log(`[golden-lane] 通过：${baselines.length} 张截图与 golden 基准像素一致（阈值 ${MAX_DIFF_RATIO * 100}%）。`);
