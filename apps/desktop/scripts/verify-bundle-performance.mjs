import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const distRoot = path.join(desktopRoot, "dist");
const budgets = JSON.parse(fs.readFileSync(path.join(desktopRoot, "performance-budgets.json"), "utf8"));
if (budgets.version !== 1) throw new Error(`Unsupported performance budget version: ${budgets.version}`);
if (!fs.existsSync(path.join(distRoot, "index.html"))) throw new Error("Renderer dist is missing; run pnpm build first.");

const outputRoot = path.resolve(process.env.PI_PERFORMANCE_OUTPUT_DIR ?? path.join(desktopRoot, "../../artifacts/performance"));
fs.mkdirSync(outputRoot, { recursive: true });

const indexHtml = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
const assetNames = fs.readdirSync(path.join(distRoot, "assets")).filter((name) => /\.(?:js|css)$/.test(name));
const metrics = assetNames.map((name) => {
  const content = fs.readFileSync(path.join(distRoot, "assets", name));
  return { name, rawBytes: content.byteLength, gzipBytes: gzipSync(content, { level: 9 }).byteLength };
});
const referencedAsset = (extension) => {
  const tag = extension === "js" ? "script" : "link";
  const attribute = extension === "js" ? "src" : "href";
  const matches = [...indexHtml.matchAll(new RegExp(`<${tag}[^>]+${attribute}=["']\\.?/assets/([^"']+\\.${extension})["'][^>]*>`, "g"))];
  if (matches.length !== 1) throw new Error(`Expected one entry .${extension} asset in dist/index.html; found ${matches.length}.`);
  const metric = metrics.find((candidate) => candidate.name === matches[0][1]);
  if (!metric) throw new Error(`Referenced entry asset is missing: ${matches[0][1]}`);
  return metric;
};
const entryJs = referencedAsset("js");
const mainCss = referencedAsset("css");
const asyncJs = metrics.filter((metric) => metric.name.endsWith(".js") && metric.name !== entryJs.name);
const maxAsyncJs = asyncJs.reduce((largest, metric) => metric.rawBytes > largest.rawBytes ? metric : largest, { name: "none", rawBytes: 0, gzipBytes: 0 });
const totals = metrics.reduce((sum, metric) => ({ rawBytes: sum.rawBytes + metric.rawBytes, gzipBytes: sum.gzipBytes + metric.gzipBytes }), { rawBytes: 0, gzipBytes: 0 });

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  budgets: budgets.bundle,
  entryJs,
  mainCss,
  maxAsyncJs,
  totals,
  assets: metrics.sort((left, right) => right.rawBytes - left.rawBytes),
};
fs.writeFileSync(path.join(outputRoot, "bundle-report.json"), `${JSON.stringify(report, null, 2)}\n`);

const checks = [
  ["entry JS raw", entryJs.rawBytes, budgets.bundle.entryJsRawBytes],
  ["entry JS gzip", entryJs.gzipBytes, budgets.bundle.entryJsGzipBytes],
  ["largest async JS raw", maxAsyncJs.rawBytes, budgets.bundle.maxAsyncJsRawBytes],
  ["largest async JS gzip", maxAsyncJs.gzipBytes, budgets.bundle.maxAsyncJsGzipBytes],
  ["total JS/CSS raw", totals.rawBytes, budgets.bundle.totalJsCssRawBytes],
  ["total JS/CSS gzip", totals.gzipBytes, budgets.bundle.totalJsCssGzipBytes],
  ["main CSS raw", mainCss.rawBytes, budgets.bundle.mainCssRawBytes],
  ["main CSS gzip", mainCss.gzipBytes, budgets.bundle.mainCssGzipBytes],
];
const failures = checks.filter(([, actual, limit]) => actual > limit);
for (const [label, actual, limit] of checks) console.log(`[bundle-budget] ${label}: ${actual} / ${limit} bytes`);
if (failures.length > 0) {
  throw new Error(`Bundle performance budget exceeded: ${failures.map(([label, actual, limit]) => `${label} ${actual} > ${limit}`).join("; ")}`);
}
console.log(`[bundle-budget] passed; report: ${path.join(outputRoot, "bundle-report.json")}`);
