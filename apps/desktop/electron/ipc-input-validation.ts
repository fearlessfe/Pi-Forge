import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  maxPromptAttachmentNameBytes,
  maxPromptImageBytes,
  maxPromptImagesPerMessage,
  maxPromptImageTotalBytes,
  maxPromptMimeTypeLength,
  maxPromptTextAttachmentBytes,
  maxPromptTextAttachmentsPerMessage,
  maxPromptTextAttachmentTotalBytes,
  supportedPromptImageMimeTypes,
  type BrowserBounds,
  type ContextBudgetRequest,
  type ConversationListQuery,
  type ModelMetadataOverride,
  type PackageCapabilityProvider,
  type PermissionSettings,
  type PromptFileAttachment,
  type PromptImage,
  type ProjectResourceSelection,
  type QueuePromptInput,
  type ResourceSettings,
  type ResolvePlanReviewInput,
  type SaveMcpServerInput,
  type SaveConversationExecutionProfile,
  type SaveModelSettings,
  type SaveObservabilitySettings,
  type SendPromptInput,
  type SubagentProvider,
  type SystemPromptSettings,
} from "../src/contracts.js";

const maxPromptCharacters = 1024 * 1024;
const maxBase64ImageCharacters = Math.ceil(maxPromptImageBytes / 3) * 4;
const stringMapSchema = Type.Record(
  Type.String({ maxLength: 256 }),
  Type.String({ maxLength: 16 * 1024 }),
  { maxProperties: 128 },
);

const promptImageSchema = Type.Object({
  name: Type.String({ maxLength: maxPromptAttachmentNameBytes }),
  mimeType: Type.String({ maxLength: maxPromptMimeTypeLength }),
  data: Type.String({ maxLength: maxBase64ImageCharacters }),
}, { additionalProperties: false });

const promptFileAttachmentSchema = Type.Object({
  name: Type.String({ maxLength: maxPromptAttachmentNameBytes }),
  mimeType: Type.Optional(Type.String({ maxLength: maxPromptMimeTypeLength })),
  content: Type.String({ maxLength: maxPromptTextAttachmentBytes }),
}, { additionalProperties: false });

const promptExtrasProperties = {
  images: Type.Optional(Type.Array(promptImageSchema, { maxItems: maxPromptImagesPerMessage })),
  attachments: Type.Optional(Type.Array(promptFileAttachmentSchema, { maxItems: maxPromptTextAttachmentsPerMessage })),
};

export const sendPromptInputSchema = Type.Object({
  prompt: Type.String({ maxLength: maxPromptCharacters }),
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
  conversationId: Type.Optional(Type.String({ maxLength: 256 })),
  ...promptExtrasProperties,
}, { additionalProperties: false });

export const queuePromptInputSchema = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 256 }),
  prompt: Type.String({ maxLength: maxPromptCharacters }),
  mode: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
  ...promptExtrasProperties,
}, { additionalProperties: false });

export const conversationExecutionProfileSchema = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 256 }),
  provider: Type.String({ minLength: 1, maxLength: 128 }),
  baseUrl: Type.String({ maxLength: 2048 }),
  modelId: Type.String({ minLength: 1, maxLength: 256 }),
  thinkingLevel: Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  resourceSelectionMode: Type.Union([Type.Literal("inherit"), Type.Literal("custom")]),
  selectedSkills: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1_000 }),
  selectedMcpServers: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 1_000 }),
}, { additionalProperties: false });

export const contextBudgetRequestSchema = Type.Object({
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });

export const conversationListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ pattern: "^(?:[0-9]{1,16}|v1:[A-Za-z0-9_-]{1,512})$", maxLength: 515 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  query: Type.Optional(Type.String({ maxLength: 500 })),
  archived: Type.Optional(Type.Boolean()),
  projectId: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });

export const resolvePlanReviewInputSchema = Type.Object({
  reviewId: Type.String({ minLength: 1, maxLength: 256 }),
  versionId: Type.String({ minLength: 1, maxLength: 256 }),
  decision: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested")]),
  annotations: Type.Array(Type.Object({
    anchorId: Type.String({ minLength: 1, maxLength: 256 }),
    quote: Type.String({ maxLength: 500 }),
    comment: Type.String({ minLength: 1, maxLength: 4_000 }),
  }, { additionalProperties: false }), { maxItems: 50 }),
}, { additionalProperties: false });

export const modelSettingsInputSchema = Type.Object({
  provider: Type.String({ maxLength: 128 }),
  baseUrl: Type.String({ maxLength: 2048 }),
  modelId: Type.String({ maxLength: 256 }),
  thinkingLevel: Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
  ]),
  apiKey: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
}, { additionalProperties: false });

const mcpTransportSchema = Type.Union([
  Type.Object({
    type: Type.Literal("stdio"),
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
    cwd: Type.Optional(Type.String({ maxLength: 4096 })),
    environment: stringMapSchema,
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("streamable-http"),
    url: Type.String({ minLength: 1, maxLength: 4096 }),
    headers: stringMapSchema,
  }, { additionalProperties: false }),
]);

export const mcpServerInputSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
  enabled: Type.Boolean(),
  timeoutMs: Type.Number({ minimum: 0, maximum: 300_000 }),
  transport: mcpTransportSchema,
  previousKey: Type.Optional(Type.String({ maxLength: 512 })),
  projectPath: Type.Optional(Type.String({ maxLength: 4096 })),
  secretEnvironment: Type.Optional(stringMapSchema),
  secretHeaders: Type.Optional(stringMapSchema),
  clearCredentials: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const permissionSettingsSchema = Type.Object({
  mode: Type.Union([Type.Literal("balanced"), Type.Literal("strict")]),
}, { additionalProperties: false });

export const systemPromptSettingsSchema = Type.Object({
  content: Type.String({ maxLength: 1024 * 1024 }),
}, { additionalProperties: false });

export const resourceSettingsSchema = Type.Object({
  workspaceContextEnabled: Type.Boolean(),
  disabledSkills: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1_000 }),
}, { additionalProperties: false });

export const projectResourceSelectionSchema = Type.Object({
  skills: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1_000 }),
  mcpServers: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 1_000 }),
}, { additionalProperties: false });

const pricingSchema = Type.Object({
  input: Type.Number({ minimum: 0, maximum: 1_000_000 }),
  output: Type.Number({ minimum: 0, maximum: 1_000_000 }),
  cacheRead: Type.Number({ minimum: 0, maximum: 1_000_000 }),
  cacheWrite: Type.Number({ minimum: 0, maximum: 1_000_000 }),
}, { additionalProperties: false });

export const modelMetadataOverrideSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 256 }),
  contextWindow: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  maxOutputTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
  pricing: pricingSchema,
}, { additionalProperties: false });

const otlpExporterSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  endpoint: Type.String({ minLength: 1, maxLength: 4096 }),
  enabled: Type.Boolean(),
  headers: Type.Optional(stringMapSchema),
}, { additionalProperties: false });

export const observabilitySettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  serviceName: Type.String({ minLength: 1, maxLength: 256 }),
  captureContent: Type.Union([Type.Literal("none"), Type.Literal("metadata"), Type.Literal("full")]),
  localFileEnabled: Type.Boolean(),
  exporters: Type.Array(otlpExporterSchema, { maxItems: 32 }),
}, { additionalProperties: false });

export const browserBoundsSchema = Type.Object({
  x: Type.Integer({ minimum: -100_000, maximum: 100_000 }),
  y: Type.Integer({ minimum: -100_000, maximum: 100_000 }),
  width: Type.Integer({ minimum: 1, maximum: 100_000 }),
  height: Type.Integer({ minimum: 1, maximum: 100_000 }),
}, { additionalProperties: false });

export const subagentProviderSchema = Type.Union([
  Type.Object({ kind: Type.Literal("builtin") }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("plugin"),
    source: Type.String({ minLength: 1, maxLength: 512 }),
    toolName: Type.String({ minLength: 1, maxLength: 256 }),
  }, { additionalProperties: false }),
]);

export const packageCapabilityProviderSchema = Type.Union([
  Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("plugin"), source: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
]);

const supportedImageMimeTypes = new Set<string>(supportedPromptImageMimeTypes);
const supportedApplicationTextMimeTypes = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/sql",
]);

export type IpcErrorCode = "INVALID_INPUT" | "PAYLOAD_TOO_LARGE";

export class IpcInputError extends Error {
  constructor(readonly code: IpcErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "IpcInputError";
  }
}

function requireSchema<T>(schema: TSchema, value: unknown, message: string): T {
  if (!Check(schema, value)) throw new IpcInputError("INVALID_INPUT", message);
  return value as T;
}

function requireAttachmentName(value: string): string {
  const name = value.trim();
  if (!name || /[\0\r\n]/.test(name) || Buffer.byteLength(name, "utf8") > maxPromptAttachmentNameBytes) {
    throw new Error("附件名称无效或过长。");
  }
  return name;
}

function requireImageMimeType(value: string): string {
  const mimeType = value.trim().toLowerCase();
  if (!supportedImageMimeTypes.has(mimeType)) throw new Error("图片 MIME 类型无效或不受支持。");
  return mimeType;
}

function requireTextMimeType(value: string | undefined): string {
  const mimeType = value?.trim().toLowerCase() || "text/plain";
  const valid = /^text\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) || supportedApplicationTextMimeTypes.has(mimeType);
  if (!valid || mimeType.length > maxPromptMimeTypeLength) throw new Error("文件 MIME 类型无效或不受支持。");
  return mimeType;
}

function decodeBase64Image(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("图片数据不是有效的 base64。");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("图片数据不是有效的 base64。");
  if (bytes.byteLength > maxPromptImageBytes) throw new Error("单张图片大小不能超过 10 MB。");
  return bytes;
}

export function validatePromptExtras(input: { images?: unknown; attachments?: unknown }): {
  images?: PromptImage[];
  attachments?: PromptFileAttachment[];
} {
  const rawImages = input.images ?? [];
  const rawAttachments = input.attachments ?? [];
  if (!Array.isArray(rawImages) || rawImages.length > maxPromptImagesPerMessage) {
    throw new Error(`每条消息最多可添加 ${maxPromptImagesPerMessage} 张图片。`);
  }
  if (!Array.isArray(rawAttachments) || rawAttachments.length > maxPromptTextAttachmentsPerMessage) {
    throw new Error(`每条消息最多可添加 ${maxPromptTextAttachmentsPerMessage} 个文件。`);
  }

  let imageBytes = 0;
  const images = rawImages.map((raw) => {
    const image = requireSchema<PromptImage>(promptImageSchema, raw, "图片附件无效。");
    const bytes = decodeBase64Image(image.data);
    imageBytes += bytes.byteLength;
    if (imageBytes > maxPromptImageTotalBytes) throw new Error("单条消息的图片总大小不能超过 32 MB。");
    return {
      name: requireAttachmentName(image.name),
      mimeType: requireImageMimeType(image.mimeType),
      data: image.data,
    };
  });

  let attachmentBytes = 0;
  const attachments = rawAttachments.map((raw) => {
    const attachment = requireSchema<PromptFileAttachment>(promptFileAttachmentSchema, raw, "文件附件无效。");
    const size = Buffer.byteLength(attachment.content, "utf8");
    if (size > maxPromptTextAttachmentBytes) throw new Error("文件大小不能超过 1 MB。");
    attachmentBytes += size;
    if (attachmentBytes > maxPromptTextAttachmentTotalBytes) throw new Error("单条消息的文件总大小不能超过 5 MB。");
    return {
      name: requireAttachmentName(attachment.name),
      mimeType: requireTextMimeType(attachment.mimeType),
      content: attachment.content,
    };
  });

  return {
    images: images.length > 0 ? images : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

export function requireSendPromptInput(value: unknown): SendPromptInput {
  const input = requireSchema<SendPromptInput>(sendPromptInputSchema, value, "消息字段无效。");
  return { ...input, ...validatePromptExtras(input) };
}

export function requireQueuePromptInput(value: unknown): QueuePromptInput {
  const input = requireSchema<QueuePromptInput>(queuePromptInputSchema, value, "排队消息字段无效。");
  return { ...input, ...validatePromptExtras(input) };
}

export function requireConversationExecutionProfile(value: unknown): SaveConversationExecutionProfile {
  const input = requireSchema<SaveConversationExecutionProfile>(conversationExecutionProfileSchema, value, "会话执行 Profile 无效。");
  return { ...input, selectedSkills: [...new Set(input.selectedSkills)], selectedMcpServers: [...new Set(input.selectedMcpServers)] };
}

export function requireContextBudgetRequest(value: unknown): ContextBudgetRequest {
  return requireSchema<ContextBudgetRequest>(contextBudgetRequestSchema, value ?? {}, "Context Budget 请求无效。");
}

export function requireConversationListQuery(value: unknown): ConversationListQuery {
  return requireSchema<ConversationListQuery>(conversationListQuerySchema, value ?? {}, "会话列表请求无效。");
}

export function requireResolvePlanReviewInput(value: unknown): ResolvePlanReviewInput {
  return requireSchema<ResolvePlanReviewInput>(resolvePlanReviewInputSchema, value, "计划审阅结果无效。");
}

export function requireModelSettings(value: unknown): SaveModelSettings {
  return requireSchema<SaveModelSettings>(modelSettingsInputSchema, value, "模型设置字段无效。");
}

export function requireMcpServerInput(value: unknown): SaveMcpServerInput {
  return requireSchema<SaveMcpServerInput>(mcpServerInputSchema, value, "MCP Server 配置字段无效。");
}

export function requirePermissionSettings(value: unknown): PermissionSettings {
  return requireSchema<PermissionSettings>(permissionSettingsSchema, value, "权限设置格式无效。");
}

export function requireSystemPromptSettings(value: unknown): SystemPromptSettings {
  return requireSchema<SystemPromptSettings>(systemPromptSettingsSchema, value, "系统提示词格式无效。");
}

export function requireResourceSettings(value: unknown): ResourceSettings {
  return requireSchema<ResourceSettings>(resourceSettingsSchema, value, "资源设置格式无效。");
}

export function requireProjectResourceSelection(value: unknown): ProjectResourceSelection | undefined {
  if (value === undefined) return undefined;
  const input = requireSchema<ProjectResourceSelection>(projectResourceSelectionSchema, value, "项目资源选择格式无效。");
  return { skills: [...new Set(input.skills)], mcpServers: [...new Set(input.mcpServers)] };
}

export function requireModelMetadataOverride(value: unknown): ModelMetadataOverride {
  return requireSchema<ModelMetadataOverride>(modelMetadataOverrideSchema, value, "模型元数据字段无效。");
}

export function requireObservabilitySettings(value: unknown): SaveObservabilitySettings {
  return requireSchema<SaveObservabilitySettings>(observabilitySettingsSchema, value, "Trace 设置字段无效。");
}

export function requireBrowserBounds(value: unknown): BrowserBounds {
  return requireSchema<BrowserBounds>(browserBoundsSchema, value, "浏览器边界无效。");
}

export function requireSubagentProvider(value: unknown): SubagentProvider {
  return requireSchema<SubagentProvider>(subagentProviderSchema, value, "Subagent 提供者配置无效。");
}

export function requirePackageCapabilityProvider(value: unknown): PackageCapabilityProvider {
  return requireSchema<PackageCapabilityProvider>(packageCapabilityProviderSchema, value, "能力提供者配置无效。");
}
