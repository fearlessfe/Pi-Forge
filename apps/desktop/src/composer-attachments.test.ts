import { describe, expect, it } from "vitest";
import {
  classifyAttachmentFile,
  hasComposerAttachments,
  promptFileAttachmentsOf,
  promptImagesOf,
  turnAttachmentsOf,
  type ComposerAttachments,
} from "./composer-attachments.js";

describe("classifyAttachmentFile", () => {
  it("classifies images by MIME type regardless of extension", () => {
    expect(classifyAttachmentFile("shot.png", "image/png")).toBe("image");
    expect(classifyAttachmentFile("no-extension", "image/jpeg")).toBe("image");
  });

  it("classifies text files by MIME type or well-known extension", () => {
    expect(classifyAttachmentFile("notes.txt", "text/plain")).toBe("text");
    expect(classifyAttachmentFile("data.json", "application/json")).toBe("text");
    expect(classifyAttachmentFile("script.py", "")).toBe("text");
    expect(classifyAttachmentFile("config.YAML", "")).toBe("text");
    expect(classifyAttachmentFile("Makefile", "")).toBe("text");
  });

  it("rejects unsupported binary files", () => {
    expect(classifyAttachmentFile("slides.pdf", "application/pdf")).toBe("unsupported");
    expect(classifyAttachmentFile("archive.zip", "")).toBe("unsupported");
    expect(classifyAttachmentFile("binary", "")).toBe("unsupported");
  });
});

describe("composer attachment payloads", () => {
  const attachments: ComposerAttachments = {
    images: [{ id: "1", name: "shot.png", mimeType: "image/png", data: "QUJD", dataUrl: "data:image/png;base64,QUJD" }],
    files: [{ id: "2", name: "notes.txt", mimeType: "text/plain", size: 10, content: "some notes" }],
  };

  it("detects non-empty attachment state", () => {
    expect(hasComposerAttachments({ images: [], files: [] })).toBe(false);
    expect(hasComposerAttachments(attachments)).toBe(true);
  });

  it("builds wire payloads without preview-only fields", () => {
    expect(promptImagesOf(attachments)).toEqual([{ name: "shot.png", mimeType: "image/png", data: "QUJD" }]);
    expect(promptFileAttachmentsOf(attachments)).toEqual([{ name: "notes.txt", mimeType: "text/plain", content: "some notes" }]);
  });

  it("builds turn attachments with image previews and file chips", () => {
    expect(turnAttachmentsOf(attachments)).toEqual([
      { kind: "image", name: "shot.png", dataUrl: "data:image/png;base64,QUJD" },
      { kind: "file", name: "notes.txt", mimeType: "text/plain", size: 10, access: "inline" },
    ]);
  });

  it("marks large text files for on-demand reading", () => {
    expect(turnAttachmentsOf({ images: [], files: [{
      id: "large",
      name: "large.log",
      mimeType: "text/plain",
      size: 64 * 1024 + 1,
      content: "content",
    }] })).toEqual([{ kind: "file", name: "large.log", mimeType: "text/plain", size: 65_537, access: "tool" }]);
  });
});
