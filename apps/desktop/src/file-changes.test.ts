import { describe, expect, it } from "vitest";
import { fileExtension, isArtifactChange } from "./file-changes.js";

describe("file change presentation", () => {
  it("recognizes binary and large-file patch markers with paths", () => {
    expect(isArtifactChange({ patch: "Binary or large file changed" })).toBe(true);
    expect(isArtifactChange({ patch: "Binary or large file changed: build/report.pdf" })).toBe(true);
    expect(isArtifactChange({ patch: "--- a/file.ts\n+++ b/file.ts" })).toBe(false);
  });

  it("derives a compact artifact type label", () => {
    expect(fileExtension("build/report.pdf")).toBe("PDF");
    expect(fileExtension("images\\hero.final.png")).toBe("PNG");
    expect(fileExtension("README")).toBe("FILE");
  });
});
