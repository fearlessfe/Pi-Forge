import type { BrowserAnnotationResult } from "../src/contracts.js";

const localHostPattern = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i;

export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) return "about:blank";
  const localAddress = localHostPattern.test(value);
  const candidate = localAddress
    ? `http://${value}`
    : /^[a-z][a-z0-9+.-]*:/i.test(value)
      ? value
      : `https://${value}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "about:") {
    throw new Error("内置浏览器只允许打开 HTTP 或 HTTPS 页面。");
  }
  if (parsed.protocol === "about:" && parsed.href !== "about:blank") {
    throw new Error("内置浏览器只允许打开 HTTP 或 HTTPS 页面。");
  }
  return parsed.href;
}

function inlineRecord(record: Record<string, string>): string {
  return Object.entries(record).map(([key, value]) => `${key}="${value}"`).join(", ");
}

export function formatBrowserAnnotation(result: BrowserAnnotationResult): string {
  if (!result.success) return result.cancelled
    ? `Browser annotation cancelled${result.reason ? `: ${result.reason}` : "."}`
    : `Browser annotation failed${result.reason ? `: ${result.reason}` : "."}`;

  const lines = [
    `## Page Annotation: ${result.url || "Unknown"}`,
    `**Title:** ${result.title || "Untitled"}`,
    `**Viewport:** ${result.viewport.width}×${result.viewport.height} @${result.viewport.deviceScaleFactor}x`,
  ];
  if (result.prompt) lines.push("", `**Context:** ${result.prompt}`);
  lines.push("", `### Selected Elements (${result.elements.length})`, "");

  if (result.elements.length === 0) lines.push("*No elements selected*", "");
  for (const element of result.elements) {
    lines.push(`${element.index}. **${element.tag}**`, `   - Selector: \`${element.selector}\``);
    if (element.id) lines.push(`   - ID: \`${element.id}\``);
    if (element.classes.length > 0) lines.push(`   - Classes: \`${element.classes.join(", ")}\``);
    if (element.text) lines.push(`   - Text: ${JSON.stringify(element.text)}`);
    lines.push(`   - Rect: ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} at (${Math.round(element.rect.x)}, ${Math.round(element.rect.y)})`);
    if (Object.keys(element.attributes).length > 0) lines.push(`   - Attributes: ${inlineRecord(element.attributes)}`);
    if (Object.keys(element.styles).length > 0) {
      lines.push(`   - Styles: ${Object.entries(element.styles).map(([key, value]) => `${key}: ${value}`).join(", ")}`);
    }
    const accessibility = [
      element.accessibility.role ? `role=${element.accessibility.role}` : undefined,
      element.accessibility.name ? `name=${JSON.stringify(element.accessibility.name)}` : undefined,
      `focusable=${element.accessibility.focusable}`,
      `disabled=${element.accessibility.disabled}`,
    ].filter(Boolean).join(", ");
    lines.push(`   - Accessibility: ${accessibility}`);
    if (element.comment) lines.push(`   - **Comment:** ${element.comment}`);
    lines.push("");
  }

  if (result.screenshotPath) lines.push(`### Screenshot`, "", result.screenshotPath, "");
  return lines.join("\n").trim();
}
