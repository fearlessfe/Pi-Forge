import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentStore,
  inlineAttachmentMaxBytes,
  maxAttachmentReadBytes,
} from "./attachment-store.js";

const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-attachment-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("AttachmentStore", () => {
  it("stores files under capability IDs with restrictive permissions", () => {
    const sessionDir = createDirectory();
    const [attachment] = new AttachmentStore(sessionDir).create("conversation-1", [{
      name: "../../notes.txt",
      mimeType: "text/plain",
      content: "hello",
    }]);

    expect(attachment).toMatchObject({
      ownerConversationId: "conversation-1",
      name: "../../notes.txt",
      size: 5,
      access: "inline",
    });
    const root = path.join(sessionDir, ".attachments");
    expect(fs.readdirSync(root).sort()).toEqual([`${attachment.id}.json`, `${attachment.id}.txt`]);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, `${attachment.id}.txt`)).mode & 0o777).toBe(0o600);
  });

  it("marks large files for tools and reads UTF-8 content in bounded chunks", () => {
    const store = new AttachmentStore(createDirectory());
    const content = `开头-${"a".repeat(inlineAttachmentMaxBytes)}-结尾`;
    const [attachment] = store.create("conversation-2", [{ name: "large.log", content }]);
    expect(attachment.access).toBe("tool");

    let offset = 0;
    let rebuilt = "";
    while (true) {
      const part = store.read(attachment.id, offset, 257);
      rebuilt += part.content;
      offset = part.nextOffset;
      if (part.eof) break;
    }
    expect(rebuilt).toBe(content);
    expect(() => store.read(attachment.id, 0, maxAttachmentReadBytes + 1)).toThrow("每次最多读取");
  });

  it("rejects invalid IDs and message-level size limits", () => {
    const store = new AttachmentStore(createDirectory());
    expect(() => store.read("../../secret", 0, 10)).toThrow("附件 ID 无效");
    expect(() => store.create("conversation-3", Array.from({ length: 11 }, (_, index) => ({
      name: `${index}.txt`,
      content: "x",
    })))).toThrow("最多可添加 10 个文件");
    expect(() => store.create("conversation-3", Array.from({ length: 6 }, (_, index) => ({
      name: `${index}.txt`,
      content: "x".repeat(900 * 1024),
    })))).toThrow("文件总大小不能超过 5 MB");
  });
});
