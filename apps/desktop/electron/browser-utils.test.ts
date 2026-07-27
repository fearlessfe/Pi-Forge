import { describe, expect, it } from "vitest";
import type { BrowserAnnotationResult } from "../src/contracts.js";
import { formatBrowserAnnotation, normalizeBrowserUrl } from "./browser-utils.js";

describe("normalizeBrowserUrl", () => {
  it("uses http for local development addresses", () => {
    expect(normalizeBrowserUrl("localhost:4173/debug")).toBe("http://localhost:4173/debug");
    expect(normalizeBrowserUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("uses https for public hostnames", () => {
    expect(normalizeBrowserUrl("example.com/path")).toBe("https://example.com/path");
  });

  it("rejects privileged and local file protocols", () => {
    expect(() => normalizeBrowserUrl("file:///tmp/example.html")).toThrow("HTTP 或 HTTPS");
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow("HTTP 或 HTTPS");
  });
});

describe("formatBrowserAnnotation", () => {
  it("formats structured element context and screenshot evidence", () => {
    const result: BrowserAnnotationResult = {
      success: true,
      url: "http://localhost:4173/",
      title: "Dashboard",
      prompt: "Fix the primary action",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      screenshotPath: "/tmp/pi-browser-annotation.png",
      elements: [{
        index: 1,
        tag: "button",
        selector: "#save",
        id: "save",
        classes: ["primary"],
        text: "Save",
        comment: "Contrast is too low",
        rect: { x: 20, y: 30, width: 120, height: 40 },
        attributes: { type: "button" },
        styles: { backgroundColor: "rgb(20, 20, 20)" },
        accessibility: { role: "button", name: "Save", focusable: true, disabled: false },
      }],
    };

    const markdown = formatBrowserAnnotation(result);
    expect(markdown).toContain("## Page Annotation: http://localhost:4173/");
    expect(markdown).toContain("Selector: `#save`");
    expect(markdown).toContain("**Comment:** Contrast is too low");
    expect(markdown).toContain("/tmp/pi-browser-annotation.png");
  });
});
