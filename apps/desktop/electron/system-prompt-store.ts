import fs from "node:fs";
import path from "node:path";
import type { SystemPromptSettings } from "../src/contracts.js";

export const maxSystemPromptLength = 100_000;

export class SystemPromptStore {
  private readonly filePath: string;

  constructor(agentDir: string) {
    this.filePath = path.join(agentDir, "APPEND_SYSTEM.md");
  }

  get(): SystemPromptSettings {
    if (!fs.existsSync(this.filePath)) return { content: "" };
    return this.validate({ content: fs.readFileSync(this.filePath, "utf8") });
  }

  save(input: SystemPromptSettings): SystemPromptSettings {
    const next = this.validate(input);
    if (!next.content) {
      fs.rmSync(this.filePath, { force: true });
      return next;
    }

    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, next.content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
    return next;
  }

  private validate(value: unknown): SystemPromptSettings {
    if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).content !== "string") {
      throw new Error("系统提示词格式无效。");
    }
    const content = (value as SystemPromptSettings).content.trim();
    if (content.length > maxSystemPromptLength) {
      throw new Error(`系统提示词不能超过 ${maxSystemPromptLength.toLocaleString("en-US")} 个字符。`);
    }
    return { content };
  }
}
