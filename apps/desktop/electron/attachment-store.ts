import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  inlineTextAttachmentMaxBytes,
  maxPromptAttachmentNameBytes,
  maxPromptTextAttachmentBytes,
  maxPromptTextAttachmentsPerMessage,
  maxPromptTextAttachmentTotalBytes,
  type PromptFileAttachment,
} from "../src/contracts.js";

export const inlineAttachmentMaxBytes = inlineTextAttachmentMaxBytes;
export const maxAttachmentBytes = maxPromptTextAttachmentBytes;
export const maxAttachmentsPerMessage = maxPromptTextAttachmentsPerMessage;
export const maxAttachmentTotalBytes = maxPromptTextAttachmentTotalBytes;
export const defaultAttachmentReadBytes = 16 * 1024;
export const maxAttachmentReadBytes = 32 * 1024;

export type StoredAttachment = {
  id: string;
  ownerConversationId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  access: "inline" | "tool";
  createdAt: string;
};

export type PreparedAttachment = StoredAttachment & {
  content: string;
};

export type AttachmentReadResult = StoredAttachment & {
  offset: number;
  nextOffset: number;
  eof: boolean;
  content: string;
};

function requireAttachmentId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("附件 ID 无效。");
  }
  return id;
}

function normalizeMimeType(value: string | undefined): string {
  const mimeType = value?.trim().toLowerCase();
  return mimeType && mimeType.length <= 128 ? mimeType : "text/plain";
}

function safeChunkEnd(buffer: Buffer, start: number, requestedEnd: number): number {
  if (requestedEnd >= buffer.length) return buffer.length;
  let end = requestedEnd;
  while (end > start && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end > start ? end : requestedEnd;
}

export class AttachmentStore {
  private readonly root: string;

  constructor(sessionDir: string) {
    this.root = path.join(sessionDir, ".attachments");
  }

  create(ownerConversationId: string, attachments: PromptFileAttachment[]): PreparedAttachment[] {
    if (attachments.length > maxAttachmentsPerMessage) {
      throw new Error(`每条消息最多可添加 ${maxAttachmentsPerMessage} 个文件。`);
    }
    if (attachments.length === 0) return [];
    const prepared = attachments.map((attachment) => {
      const content = attachment.content;
      const data = Buffer.from(content, "utf8");
      if (data.byteLength > maxAttachmentBytes) throw new Error("文件大小不能超过 1 MB。");
      const name = attachment.name.trim() || "untitled.txt";
      if (Buffer.byteLength(name, "utf8") > maxPromptAttachmentNameBytes) throw new Error("文件名过长。");
      const metadata: StoredAttachment = {
        id: randomUUID(),
        ownerConversationId,
        name,
        mimeType: normalizeMimeType(attachment.mimeType),
        size: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
        access: data.byteLength <= inlineAttachmentMaxBytes ? "inline" : "tool",
        createdAt: new Date().toISOString(),
      };
      return { ...metadata, content, data };
    });
    if (prepared.reduce((total, attachment) => total + attachment.size, 0) > maxAttachmentTotalBytes) {
      throw new Error("单条消息的文件总大小不能超过 5 MB。");
    }

    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    const written: string[] = [];
    try {
      for (const attachment of prepared) {
        const contentPath = this.contentPath(attachment.id);
        const metadataPath = this.metadataPath(attachment.id);
        fs.writeFileSync(contentPath, attachment.data, { flag: "wx", mode: 0o600 });
        written.push(contentPath);
        const { content: _content, data: _data, ...metadata } = attachment;
        fs.writeFileSync(metadataPath, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
        written.push(metadataPath);
      }
    } catch (error) {
      for (const filename of written) fs.rmSync(filename, { force: true });
      throw error;
    }
    return prepared.map(({ data: _data, ...attachment }) => attachment);
  }

  metadata(id: string): StoredAttachment {
    const validatedId = requireAttachmentId(id);
    const value = JSON.parse(fs.readFileSync(this.metadataPath(validatedId), "utf8")) as StoredAttachment;
    if (value.id !== validatedId || typeof value.name !== "string" || typeof value.size !== "number") {
      throw new Error("附件元数据无效。");
    }
    return value;
  }

  list(ids: Iterable<string>): StoredAttachment[] {
    const result: StoredAttachment[] = [];
    for (const id of new Set(ids)) {
      try {
        result.push(this.metadata(id));
      } catch {
        // 会话可能来自其他设备或附件已被清理；列表忽略不可用引用。
      }
    }
    return result;
  }

  read(id: string, offset = 0, limit = defaultAttachmentReadBytes): AttachmentReadResult {
    const metadata = this.metadata(id);
    if (!Number.isInteger(offset) || offset < 0) throw new Error("附件读取偏移量无效。");
    if (!Number.isInteger(limit) || limit <= 0 || limit > maxAttachmentReadBytes) {
      throw new Error(`每次最多读取 ${maxAttachmentReadBytes} 字节。`);
    }
    const buffer = fs.readFileSync(this.contentPath(metadata.id));
    if (offset > buffer.length) throw new Error("附件读取偏移量超出文件范围。");
    let start = offset;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    const end = safeChunkEnd(buffer, start, Math.min(start + limit, buffer.length));
    return {
      ...metadata,
      offset: start,
      nextOffset: end,
      eof: end >= buffer.length,
      content: buffer.subarray(start, end).toString("utf8"),
    };
  }

  private contentPath(id: string): string {
    return path.join(this.root, `${requireAttachmentId(id)}.txt`);
  }

  private metadataPath(id: string): string {
    return path.join(this.root, `${requireAttachmentId(id)}.json`);
  }
}
