import { describe, expect, it } from "vitest";
import {
  requireContextBudgetRequest,
  requireMcpServerInput,
  requireModelSettings,
  requireQueuePromptInput,
  requireSendPromptInput,
  validatePromptExtras,
} from "./ipc-input-validation.js";

function image(data = Buffer.from("image").toString("base64")) {
  return { name: "shot.png", mimeType: "image/png", data };
}

describe("IPC input validation", () => {
  it("strictly validates Context Budget requests", () => {
    expect(requireContextBudgetRequest(undefined)).toEqual({});
    expect(requireContextBudgetRequest({ cwd: "/workspace" })).toEqual({ cwd: "/workspace" });
    expect(() => requireContextBudgetRequest({ cwd: 42 })).toThrow("Context Budget 请求无效");
    expect(() => requireContextBudgetRequest({ cwd: "/workspace", readFile: true })).toThrow("Context Budget 请求无效");
  });

  it("accepts and normalizes bounded send and queue inputs", () => {
    expect(requireSendPromptInput({
      prompt: "inspect",
      cwd: "/workspace",
      images: [{ ...image(), name: "  shot.png  ", mimeType: "IMAGE/PNG" }],
      attachments: [{ name: " notes.md ", mimeType: "TEXT/MARKDOWN", content: "hello" }],
    })).toMatchObject({
      prompt: "inspect",
      images: [{ name: "shot.png", mimeType: "image/png" }],
      attachments: [{ name: "notes.md", mimeType: "text/markdown", content: "hello" }],
    });
    expect(requireQueuePromptInput({ prompt: "continue", mode: "followUp" })).toEqual({
      prompt: "continue",
      mode: "followUp",
      images: undefined,
      attachments: undefined,
    });
  });

  it("rejects extra fields, invalid modes, and too many images", () => {
    expect(() => requireSendPromptInput({ prompt: "hello", privileged: true })).toThrow("消息字段无效");
    expect(() => requireQueuePromptInput({ prompt: "hello", mode: "later" })).toThrow("排队消息字段无效");
    expect(() => validatePromptExtras({ images: Array.from({ length: 9 }, () => image()) })).toThrow("最多可添加 8 张图片");
  });

  it("validates base64, decoded image size, MIME type, and UTF-8 name length", () => {
    expect(() => validatePromptExtras({ images: [image("not base64")] })).toThrow("有效的 base64");
    expect(() => validatePromptExtras({ images: [{ ...image(), mimeType: "image/svg+xml" }] })).toThrow("MIME 类型");
    expect(() => validatePromptExtras({ images: [{ ...image(), name: "界".repeat(171) }] })).toThrow("名称无效或过长");

    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    expect(() => validatePromptExtras({ images: [image(oversized)] })).toThrow("单张图片大小不能超过 10 MB");
  });

  it("enforces text attachment bytes and MIME types", () => {
    const oversizedUtf8 = "😀".repeat(262_145);
    expect(() => validatePromptExtras({
      attachments: [{ name: "unicode.txt", mimeType: "text/plain", content: oversizedUtf8 }],
    })).toThrow("文件大小不能超过 1 MB");
    expect(() => validatePromptExtras({
      attachments: [{ name: "payload.bin", mimeType: "application/octet-stream", content: "x" }],
    })).toThrow("文件 MIME 类型");
  });

  it("enforces aggregate image and text attachment limits", () => {
    const imagePayload = Buffer.alloc(9 * 1024 * 1024).toString("base64");
    expect(() => validatePromptExtras({
      images: Array.from({ length: 4 }, () => image(imagePayload)).map((entry, index) => ({
        ...entry,
        name: `shot-${index}.png`,
      })),
    })).toThrow("图片总大小不能超过 32 MB");

    const textPayload = "x".repeat(900 * 1024);
    expect(() => validatePromptExtras({
      attachments: Array.from({ length: 6 }, (_, index) => ({
        name: `notes-${index}.txt`,
        mimeType: "text/plain",
        content: textPayload,
      })),
    })).toThrow("文件总大小不能超过 5 MB");
  });

  it("uses strict schemas for model settings and MCP configuration", () => {
    expect(requireModelSettings({
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      modelId: "demo",
      thinkingLevel: "high",
    })).toMatchObject({ modelId: "demo" });
    expect(() => requireModelSettings({
      provider: "openai-compatible",
      baseUrl: "https://example.com/v1",
      modelId: "demo",
      thinkingLevel: "unlimited",
    })).toThrow("模型设置字段无效");

    expect(requireMcpServerInput({
      id: "local",
      name: "Local MCP",
      scope: "user",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "stdio", command: "node", args: [], environment: {} },
    })).toMatchObject({ id: "local", transport: { type: "stdio" } });
    expect(() => requireMcpServerInput({
      id: "remote",
      name: "Remote MCP",
      scope: "user",
      enabled: true,
      timeoutMs: 30_000,
      transport: { type: "streamable-http", url: "https://example.com", headers: {}, command: "unexpected" },
    })).toThrow("MCP Server 配置字段无效");
  });
});
