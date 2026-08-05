import { describe, expect, it } from "vitest";
import {
  IpcInputError,
  requireBrowserBounds,
  requireContextBudgetRequest,
  requireConversationListQuery,
  requireMcpServerInput,
  requireModelMetadataOverride,
  requireModelSettings,
  requireObservabilitySettings,
  requirePackageCapabilityProvider,
  requirePermissionSettings,
  requireProjectResourceSelection,
  requireQueuePromptInput,
  requireResourceSettings,
  requireResolvePlanReviewInput,
  requireSendPromptInput,
  requireSubagentProvider,
  requireSystemPromptSettings,
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

  it("strictly validates bounded conversation pages", () => {
    expect(requireConversationListQuery({ cursor: "100", limit: 50, archived: false })).toEqual({ cursor: "100", limit: 50, archived: false });
    expect(requireConversationListQuery({ cursor: "v1:eyJ1cGRhdGVkQXQiOiIyMDI2IiwiaWQiOiJjLTEifQ", limit: 50 })).toEqual({ cursor: "v1:eyJ1cGRhdGVkQXQiOiIyMDI2IiwiaWQiOiJjLTEifQ", limit: 50 });
    expect(() => requireConversationListQuery({ cursor: "next", limit: 50 })).toThrow("会话列表请求无效");
    expect(() => requireConversationListQuery({ limit: 201 })).toThrow("会话列表请求无效");
  });

  it("strictly validates bounded plan review decisions", () => {
    expect(requireResolvePlanReviewInput({ reviewId: "review-1", versionId: "version-1", decision: "approved", annotations: [] })).toEqual({ reviewId: "review-1", versionId: "version-1", decision: "approved", annotations: [] });
    expect(() => requireResolvePlanReviewInput({ reviewId: "review-1", versionId: "version-1", decision: "skip", annotations: [] })).toThrow("计划审阅结果无效");
    expect(() => requireResolvePlanReviewInput({ reviewId: "review-1", versionId: "version-1", decision: "approved", annotations: [], readFile: true })).toThrow("计划审阅结果无效");
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
    expect(requireQueuePromptInput({ conversationId: "conversation-1", prompt: "continue", mode: "followUp" })).toEqual({
      conversationId: "conversation-1",
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

  // This intentionally validates more than 32 MiB of decoded image data; V8
  // coverage instrumentation makes the canonical base64 checks slower in CI.
  it("enforces aggregate image and text attachment limits", () => {
    const imagePayload = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
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
  }, 15_000);

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

  it("strictly validates remaining privileged settings and workbench inputs", () => {
    expect(requirePermissionSettings({ mode: "strict" })).toEqual({ mode: "strict" });
    expect(() => requirePermissionSettings({ mode: "admin" })).toThrow("权限设置格式无效");
    expect(requireSystemPromptSettings({ content: "Be concise." })).toEqual({ content: "Be concise." });
    expect(() => requireSystemPromptSettings({ content: "ok", executable: true })).toThrow("系统提示词格式无效");
    expect(requireResourceSettings({ workspaceContextEnabled: true, disabledSkills: ["one"] })).toEqual({ workspaceContextEnabled: true, disabledSkills: ["one"] });
    expect(() => requireResourceSettings({ workspaceContextEnabled: true, disabledSkills: "one" })).toThrow("资源设置格式无效");
    expect(requireProjectResourceSelection({ skills: ["one", "one"], mcpServers: ["mcp"] })).toEqual({ skills: ["one"], mcpServers: ["mcp"] });
    expect(() => requireProjectResourceSelection({ skills: [], mcpServers: [], unknown: true })).toThrow("项目资源选择格式无效");
    expect(requireBrowserBounds({ x: 0, y: 0, width: 800, height: 600 })).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(() => requireBrowserBounds({ x: 0, y: 0, width: -1, height: 600 })).toThrow("浏览器边界无效");
  });

  it("validates metadata, trace exporters, and capability providers without unknown fields", () => {
    expect(requireModelMetadataOverride({
      name: "Model",
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    })).toMatchObject({ name: "Model" });
    expect(() => requireModelMetadataOverride({
      name: "Model",
      contextWindow: 0,
      maxOutputTokens: 1,
      pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    })).toThrow("模型元数据字段无效");
    expect(requireObservabilitySettings({
      enabled: true,
      serviceName: "pi-forge",
      captureContent: "metadata",
      localFileEnabled: true,
      exporters: [{ name: "Tempo", endpoint: "https://tempo.example", enabled: true, headers: { authorization: "secret" } }],
    })).toMatchObject({ captureContent: "metadata" });
    expect(() => requireObservabilitySettings({ enabled: true, serviceName: "pi", captureContent: "everything", localFileEnabled: true, exporters: [] })).toThrow("Trace 设置字段无效");
    expect(requireSubagentProvider({ kind: "plugin", source: "npm:subagent@1.0.0", toolName: "delegate" })).toMatchObject({ kind: "plugin" });
    expect(() => requireSubagentProvider({ kind: "builtin", source: "unexpected" })).toThrow("Subagent 提供者配置无效");
    expect(requirePackageCapabilityProvider({ kind: "none" })).toEqual({ kind: "none" });
    expect(() => requirePackageCapabilityProvider({ kind: "plugin", source: "", privileged: true })).toThrow("能力提供者配置无效");
  });

  it("attaches a stable machine-readable code to schema failures", () => {
    let actual: unknown;
    try {
      requirePermissionSettings({ mode: "admin" });
    } catch (error) {
      actual = error;
    }
    expect(actual).toBeInstanceOf(IpcInputError);
    expect((actual as IpcInputError).code).toBe("INVALID_INPUT");
    expect((actual as Error).message).toContain("[INVALID_INPUT]");
  });
});
