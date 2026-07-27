import { describe, expect, it } from "vitest";
import { detectLocalServiceUrls, stripTerminalAnsi } from "./terminal-urls";

describe("stripTerminalAnsi", () => {
  it("removes color and terminal-title sequences", () => {
    expect(stripTerminalAnsi("\u001b[32mready\u001b[0m \u001b]0;vite\u0007server")).toBe("ready server");
  });
});

describe("detectLocalServiceUrls", () => {
  it("finds supported local service URLs in terminal output", () => {
    expect(detectLocalServiceUrls([
      "Local:   \u001b[36mhttp://localhost:5173/\u001b[39m",
      "API: https://127.0.0.1:8443/v1",
      "IPv6: http://[::1]:3000/debug",
    ].join("\n"))).toEqual([
      "http://localhost:5173/",
      "https://127.0.0.1:8443/v1",
      "http://[::1]:3000/debug",
    ]);
  });

  it("deduplicates URLs and ignores public or invalid ports", () => {
    expect(detectLocalServiceUrls("http://localhost:3000 http://localhost:3000 https://example.com:443 http://127.0.0.1:99999")).toEqual([
      "http://localhost:3000/",
    ]);
  });
});
