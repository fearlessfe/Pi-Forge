import {
  inlineTextAttachmentMaxBytes,
  maxPromptImageBytes,
  maxPromptTextAttachmentBytes,
  supportedPromptImageMimeTypes,
  type PromptFileAttachment,
  type PromptImage,
  type TurnAttachment,
} from "./contracts.js";

/** 输入框中待发送的图片附件（dataUrl 用于预览，发送时只带裸 base64）。 */
export type ComposerImage = {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  dataUrl: string;
};

/** 输入框中待发送的文本文件附件。 */
export type ComposerFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  content: string;
};

export type ComposerAttachments = {
  images: ComposerImage[];
  files: ComposerFile[];
};

export const emptyComposerAttachments: ComposerAttachments = { images: [], files: [] };

export const maxImageBytes = maxPromptImageBytes;
export const maxTextFileBytes = maxPromptTextAttachmentBytes;
export const inlineTextFileBytes = inlineTextAttachmentMaxBytes;

const textFileMimeTypes = new Set([
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

const textFileExtensions = new Set([
  "txt", "md", "markdown", "json", "js", "jsx", "ts", "tsx", "mts", "cts",
  "css", "scss", "less", "html", "htm", "xml", "svg", "yaml", "yml", "toml",
  "csv", "tsv", "sh", "bash", "zsh", "py", "rb", "go", "rs", "java", "c", "h",
  "cpp", "hpp", "cc", "cs", "php", "swift", "kt", "kts", "sql", "ini", "cfg",
  "conf", "log", "vue", "svelte", "env", "gitignore", "dockerfile", "makefile",
]);

export type AttachmentFileKind = "image" | "text" | "unsupported";

export function classifyAttachmentFile(name: string, mimeType: string): AttachmentFileKind {
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return (supportedPromptImageMimeTypes as readonly string[]).includes(normalizedMimeType) ? "image" : "unsupported";
  }
  if (mimeType.startsWith("text/") || textFileMimeTypes.has(mimeType)) return "text";
  const extension = name.includes(".") ? name.split(".").pop()!.toLocaleLowerCase() : name.toLocaleLowerCase();
  return textFileExtensions.has(extension) ? "text" : "unsupported";
}

export function hasComposerAttachments(attachments: ComposerAttachments): boolean {
  return attachments.images.length > 0 || attachments.files.length > 0;
}

export function promptImagesOf(attachments: ComposerAttachments): PromptImage[] {
  return attachments.images.map((image) => ({ name: image.name, mimeType: image.mimeType, data: image.data }));
}

export function promptFileAttachmentsOf(attachments: ComposerAttachments): PromptFileAttachment[] {
  return attachments.files.map((file) => ({ name: file.name, mimeType: file.mimeType, content: file.content }));
}

export function turnAttachmentsOf(attachments: ComposerAttachments): TurnAttachment[] {
  return [
    ...attachments.images.map((image): TurnAttachment => ({ kind: "image", name: image.name, dataUrl: image.dataUrl })),
    ...attachments.files.map((file): TurnAttachment => ({
      kind: "file",
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      access: file.size <= inlineTextFileBytes ? "inline" : "tool",
    })),
  ];
}
