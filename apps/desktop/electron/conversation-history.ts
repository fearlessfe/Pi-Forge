import fs from "node:fs";
import path from "node:path";
import { SessionManager, type AgentSession, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ConversationHistoryDetail,
  ConversationHistoryItem,
  ContextUsageInfo,
  QuestionOption,
  ResponseUsage,
  TaskFileChange,
  ToolActivityDetails,
  TurnAttachment,
} from "../src/contracts.js";
import { mergeAnswerUsage } from "../src/response-usage.js";
import { fixedProtocolModelMetadata } from "./model-metadata-catalog.js";
import { fileChangesEntryType, parseStoredFileChange, type FileChangeTracker } from "./file-changes.js";
import type { ModelCatalog } from "./model-catalog.js";
import type { SubagentRunStore } from "./subagent-run-store.js";

type ConversationMetadata = {
  tags: string[];
  archived: boolean;
};

export type ConversationHistoryDeps = {
  isRunning(): boolean;
  activeSession(): AgentSession | undefined;
  disposeSession(): void;
  modelCatalog: Pick<ModelCatalog, "getModelCatalog">;
  fileChangeTracker: Pick<FileChangeTracker, "restoreChange" | "setLastChangeRunId">;
  subagentRuns(): SubagentRunStore;
  subagentToolName: string;
};

export const initProjectPrompt = `Initialize the current workspace for future coding-agent sessions by creating or updating AGENTS.md at the workspace root.

Work autonomously and make the file change directly.

Goal:
Create a compact, high-signal instruction file that helps future agents avoid mistakes and become productive quickly. Every line should answer: "Would an agent likely miss or guess this incorrectly without help?" If not, omit it.

Investigation:
1. Read the existing AGENTS.md, if present, before editing it. Preserve accurate project-specific and manually added guidance.
2. Inspect the highest-value sources first:
   - README and contribution documentation;
   - root manifests, workspace configuration, lockfiles, and task-runner files;
   - build, development, test, lint, format, typecheck, code-generation, and migration configuration;
   - CI workflows and pre-commit configuration;
   - existing agent instructions such as CLAUDE.md, GEMINI.md, .cursor/rules, .cursorrules, and .github/copilot-instructions.md.
3. If the architecture or workflow remains unclear, inspect a small number of representative entrypoints, core modules, and tests. Prefer files that explain how the system is wired together over random leaf files.
4. Prefer executable sources of truth over prose. If documentation conflicts with scripts, configuration, or CI, trust the executable source and document the discrepancy only when it affects agent work.
5. Ask the user only when an important convention cannot be determined from the workspace. Ask at most one concise batch of questions; otherwise proceed autonomously.

What to document:
- the project's purpose and non-obvious architecture, package, process, or ownership boundaries;
- important directories and real entrypoints, without an exhaustive file inventory;
- exact setup, development, build, lint, format, typecheck, test, and packaging commands that are actually available;
- focused commands for one test, package, or verification step, plus required command ordering or prerequisites when relevant;
- repository-specific coding, testing, security, persistence, localization, or workflow conventions that differ from tool defaults;
- generated files, code generation, migrations, fixtures, snapshots, environment loading, required external services, expensive suites, platform limitations, and other verified pitfalls.

Writing rules:
- Update stale claims instead of blindly appending or replacing the file.
- Include only verified, project-specific guidance that changes how an agent should work.
- Do not invent commands, architecture, conventions, prerequisites, or secrets.
- Do not include generic software advice, long tutorials, speculative recommendations, or content already obvious from filenames.
- Prefer short sections and actionable bullets. Keep a simple workspace simple.
- For a non-code workspace, describe its purpose, key files, and how its contents are used instead of inventing software-development sections.

After writing AGENTS.md, briefly summarize what changed, which important sources were checked, which validation commands were run, and any gaps that could not be verified.`;

export function displayUserPrompt(prompt: string): string {
  return prompt.trim() === initProjectPrompt ? "/init" : prompt;
}

// 从消息正文末尾解析 AgentService.composePromptText 生成的 <file name="..."> 块。
// 只剥离结构完整且位于末尾的块；正文中间出现的同名字符串保持原样。
export function extractFileAttachments(text: string): { text: string; attachments: TurnAttachment[] } {
  const attachments: TurnAttachment[] = [];
  let rest = text;
  while (rest.endsWith("\n</file>")) {
    const openIndex = rest.lastIndexOf("<file name=\"");
    if (openIndex < 0) break;
    if (openIndex > 0 && !rest.slice(0, openIndex).endsWith("\n\n")) break;
    const header = rest.slice(openIndex + "<file name=\"".length);
    const nameEnd = header.indexOf("\">\n");
    if (nameEnd < 0) break;
    const name = header.slice(0, nameEnd);
    if (!name || name.includes("\n")) break;
    attachments.unshift({ kind: "file", name });
    rest = openIndex > 0 ? rest.slice(0, openIndex - 2) : "";
  }
  return { text: rest.trim(), attachments };
}

export function responseUsage(message: AssistantMessage): ResponseUsage {
  return {
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
    requestCount: 1,
    cost: message.usage.cost.total,
  };
}

export class ConversationHistory {
  constructor(
    private readonly sessionDir: string,
    private readonly fallbackCwd: string,
    private readonly deps: ConversationHistoryDeps,
  ) {}

  async listConversations(): Promise<ConversationHistoryItem[]> {
    const sessions = await SessionManager.listAll(this.sessionDir);
    const idsByPath = new Map(sessions.map((session) => [path.resolve(session.path), session.id]));
    return sessions
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .map((session) => this.historyItem(
        session,
        this.conversationMetadata(SessionManager.open(session.path, this.sessionDir, session.cwd || this.fallbackCwd)),
        session.parentSessionPath ? idsByPath.get(path.resolve(session.parentSessionPath)) : undefined,
      ));
  }

  async loadConversation(conversationId: string): Promise<ConversationHistoryDetail> {
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    const manager = SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd);
    const branch = manager.getBranch();
    const turns: ConversationHistoryDetail["turns"] = [];
    let latestAssistant: { message: AssistantMessage; entryIndex: number } | undefined;

    for (const [entryIndex, entry] of branch.entries()) {
      if (entry.type === "custom" && entry.customType === fileChangesEntryType) {
        const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
        const changes = Array.isArray(data.changes) ? data.changes.map(parseStoredFileChange).filter((change): change is TaskFileChange => Boolean(change)) : [];
        const current = turns.at(-1);
        if (current) current.fileChanges = changes;
        for (const change of changes) this.deps.fileChangeTracker.restoreChange(change);
        if (typeof data.runId === "string") this.deps.fileChangeTracker.setLastChangeRunId(data.runId);
        continue;
      }
      if (entry.type !== "message") continue;
      const record = entry.message as unknown as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "";
      if (role === "user") {
        const { text, attachments } = this.userMessageContent(record.content);
        const question = displayUserPrompt(text);
        if (question || attachments.length > 0) {
          turns.push({ id: entry.id, question, answer: "", activities: [], ...(attachments.length > 0 ? { attachments } : {}) });
        }
        continue;
      }
      const current = turns.at(-1);
      if (!current) continue;

      if (role === "assistant") {
        const assistant = entry.message as AssistantMessage;
        latestAssistant = { message: assistant, entryIndex };
        current.usage = mergeAnswerUsage(current.usage, responseUsage(assistant));
        for (const [contentIndex, content] of assistant.content.entries()) {
          if (content.type === "text") {
            current.answer += content.text;
            current.activities.push({ id: `${entry.id}-message-${contentIndex}`, type: "message", text: content.text });
          }
          else if (content.type === "thinking" && content.thinking) {
            current.activities.push({ id: `${entry.id}-thinking-${contentIndex}`, type: "thinking", text: content.thinking });
          } else if (content.type === "toolCall") {
            if (content.name === "ask_user") {
              const question = typeof content.arguments.question === "string" ? content.arguments.question : "Pi 需要你的回答";
              const options = Array.isArray(content.arguments.options)
                ? content.arguments.options.filter((option): option is QuestionOption => Boolean(option) && typeof option.label === "string")
                : [];
              current.activities.push({ id: content.id, type: "question", question, options, status: "pending" });
            } else {
              current.activities.push({ id: content.id, type: "tool", name: content.name, args: content.arguments, output: "", status: "running" });
            }
          }
        }
      } else if (role === "toolResult") {
        const result = entry.message as ToolResultMessage;
        const activity = current.activities.find((item) => item.id === result.toolCallId);
        if (activity?.type === "tool") {
          activity.output = this.messageText(result.content);
          activity.status = result.isError ? "error" : "success";
          const details = result.details && typeof result.details === "object" ? result.details as ToolActivityDetails : undefined;
          const subagent = activity.name === this.deps.subagentToolName
            ? this.deps.subagentRuns().findByToolCall(result.toolCallId, conversationId) ?? details?.subagent
            : undefined;
          activity.details = subagent ? { ...details, subagent } : details;
        } else if (activity?.type === "question") {
          const answer = result.details && typeof result.details === "object" && typeof (result.details as Record<string, unknown>).answer === "string"
            ? (result.details as Record<string, unknown>).answer as string
            : this.messageText(result.content).replace(/^User answered:\s*/i, "");
          activity.answer = answer;
          activity.status = "answered";
        }
      }
    }

    for (const turn of turns) {
      turn.activities = turn.activities.map((activity) => activity.type === "tool" && activity.status === "running"
        ? { ...activity, status: "error" }
        : activity);
    }

    let contextUsage: ContextUsageInfo | undefined;
    if (latestAssistant) {
      const catalog = await this.deps.modelCatalog.getModelCatalog(false);
      const contextWindow = catalog.find((provider) => provider.id === latestAssistant.message.provider)
        ?.models.find((model) => model.id === latestAssistant.message.model)?.contextWindow
        ?? fixedProtocolModelMetadata(latestAssistant.message.api, latestAssistant.message.model)?.contextWindow
        ?? 0;
      if (contextWindow > 0) {
        let latestCompactionIndex = -1;
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          if (branch[index].type === "compaction") {
            latestCompactionIndex = index;
            break;
          }
        }
        const tokens = latestAssistant.entryIndex > latestCompactionIndex ? latestAssistant.message.usage.totalTokens : null;
        contextUsage = { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 };
      }
    }
    const sessionsByPath = new Map(sessions.map((session) => [path.resolve(session.path), session.id]));
    return {
      ...this.historyItem(
        info,
        this.conversationMetadata(manager),
        info.parentSessionPath ? sessionsByPath.get(path.resolve(info.parentSessionPath)) : undefined,
      ),
      turns,
      contextUsage,
    };
  }

  async forkConversation(conversationId: string, entryId?: string): Promise<ConversationHistoryItem> {
    if (this.deps.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再 Fork 会话。");
    const { info, sessions } = await this.findConversation(conversationId);
    const source = SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd);
    const sourceMetadata = this.conversationMetadata(source);
    let fork: SessionManager;
    if (entryId) {
      if (!source.getEntry(entryId)) throw new Error("选择的会话节点不存在，请重新打开会话后再试。");
      const branch = source.getBranch();
      const selectedIndex = branch.findIndex((entry) => entry.id === entryId);
      let forkLeafId = entryId;
      for (let index = selectedIndex + 1; index < branch.length; index += 1) {
        const entry = branch[index];
        if (entry.type === "message" && (entry.message as unknown as { role?: string }).role === "user") break;
        if (entry.type !== "session_info" && !(entry.type === "custom" && entry.customType === "pi-desktop:conversation-metadata")) forkLeafId = entry.id;
      }
      const forkPath = source.createBranchedSession(forkLeafId);
      if (!forkPath) throw new Error("无法为临时会话创建 Fork。");
      fork = SessionManager.open(forkPath, this.sessionDir, info.cwd || this.fallbackCwd);
    } else {
      fork = SessionManager.forkFrom(info.path, info.cwd || this.fallbackCwd, this.sessionDir);
    }
    fork.appendSessionInfo(`Fork · ${info.name?.trim() || info.firstMessage.trim() || "未命名对话"}`.slice(0, 60));
    fork.appendCustomEntry("pi-desktop:conversation-metadata", { tags: sourceMetadata.tags, archived: false });
    const forkInfo = (await SessionManager.listAll(this.sessionDir)).find((session) => session.id === fork.getSessionId());
    if (!forkInfo) throw new Error("Fork 已创建，但无法重新读取会话索引。");
    const idsByPath = new Map([...sessions, forkInfo].map((session) => [path.resolve(session.path), session.id]));
    return this.historyItem(forkInfo, this.conversationMetadata(fork), forkInfo.parentSessionPath ? idsByPath.get(path.resolve(forkInfo.parentSessionPath)) : conversationId);
  }

  async exportConversation(conversationId: string, format: "markdown" | "json"): Promise<{ filename: string; mimeType: "text/markdown" | "application/json"; content: string }> {
    const detail = await this.loadConversation(conversationId);
    const safeName = detail.title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "conversation";
    if (format === "json") {
      return {
        filename: `${safeName}.json`,
        mimeType: "application/json",
        content: JSON.stringify(detail, null, 2),
      };
    }
    const lines = [
      `# ${detail.title}`,
      "",
      `- Created: ${detail.createdAt}`,
      `- Updated: ${detail.updatedAt}`,
      `- Workspace: ${detail.cwd}`,
      ...(detail.tags.length > 0 ? [`- Tags: ${detail.tags.join(", ")}`] : []),
      "",
    ];
    for (const turn of detail.turns) {
      lines.push("## User", "", turn.question, "", "## Pi", "", turn.answer || "_(No text response)_", "");
    }
    return { filename: `${safeName}.md`, mimeType: "text/markdown", content: lines.join("\n") };
  }

  async setConversationArchived(conversationId: string, archived: boolean): Promise<void> {
    await this.updateConversationMetadata(conversationId, { archived });
  }

  async setConversationTags(conversationId: string, tags: string[]): Promise<void> {
    const normalized = [...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, " ")).filter(Boolean))];
    if (normalized.length > 8 || normalized.some((tag) => tag.length > 24)) throw new Error("会话最多设置 8 个标签，每个标签不超过 24 个字符。");
    await this.updateConversationMetadata(conversationId, { tags: normalized });
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    if (this.deps.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再重命名会话。");
    const normalizedTitle = title.trim().replace(/\s+/g, " ");
    if (!normalizedTitle) throw new Error("会话名称不能为空。");
    if (normalizedTitle.length > 60) throw new Error("会话名称不能超过 60 个字符。");
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    const activeSession = this.deps.activeSession();
    if (activeSession?.sessionManager.getSessionId() === conversationId) {
      activeSession.setSessionName(normalizedTitle);
      return;
    }
    SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd).appendSessionInfo(normalizedTitle);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    if (this.deps.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再删除会话。");
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    if (this.deps.activeSession()?.sessionManager.getSessionId() === conversationId) this.deps.disposeSession();
    fs.unlinkSync(info.path);
  }

  private historyItem(session: SessionInfo, metadata: ConversationMetadata = { tags: [], archived: false }, parentConversationId?: string): ConversationHistoryItem {
    const isProject = Boolean(session.cwd) && path.resolve(session.cwd) !== path.resolve(this.fallbackCwd);
    const title = session.name?.trim() || displayUserPrompt(session.firstMessage).trim().replace(/\s+/g, " ") || "未命名对话";
    return {
      id: session.id,
      title: title.length > 60 ? `${title.slice(0, 60)}…` : title,
      cwd: session.cwd || this.fallbackCwd,
      createdAt: session.created.toISOString(),
      updatedAt: session.modified.toISOString(),
      tags: metadata.tags,
      archived: metadata.archived,
      searchText: session.allMessagesText.slice(0, 200_000),
      parentConversationId,
      project: isProject ? { id: session.cwd, name: path.basename(session.cwd), path: session.cwd } : undefined,
    };
  }

  private conversationMetadata(manager: SessionManager): ConversationMetadata {
    const metadata = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-desktop:conversation-metadata").at(-1);
    if (!metadata || metadata.type !== "custom" || !metadata.data || typeof metadata.data !== "object") return { tags: [], archived: false };
    const data = metadata.data as Record<string, unknown>;
    return {
      tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8) : [],
      archived: data.archived === true,
    };
  }

  private async findConversation(conversationId: string): Promise<{ info: SessionInfo; sessions: SessionInfo[] }> {
    const sessions = await SessionManager.listAll(this.sessionDir);
    const info = sessions.find((session) => session.id === conversationId);
    if (!info) throw new Error("找不到该会话，文件可能已被移动或删除。");
    return { info, sessions };
  }

  private async updateConversationMetadata(conversationId: string, patch: Partial<ConversationMetadata>): Promise<void> {
    if (this.deps.isRunning()) throw new Error("Agent 正在执行，请等待任务完成后再修改会话。");
    const { info } = await this.findConversation(conversationId);
    const activeSession = this.deps.activeSession();
    const manager = activeSession?.sessionManager.getSessionId() === conversationId
      ? activeSession.sessionManager
      : SessionManager.open(info.path, this.sessionDir, info.cwd || this.fallbackCwd);
    manager.appendCustomEntry("pi-desktop:conversation-metadata", { ...this.conversationMetadata(manager), ...patch });
  }

  private userMessageContent(content: unknown): { text: string; attachments: TurnAttachment[] } {
    const attachments: TurnAttachment[] = [];
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      let imageIndex = 0;
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        if (entry.type === "text" && typeof entry.text === "string") {
          text = text ? `${text}\n${entry.text}` : entry.text;
        } else if (entry.type === "image" && typeof entry.data === "string" && typeof entry.mimeType === "string" && entry.data && entry.mimeType) {
          imageIndex += 1;
          attachments.push({ kind: "image", name: `图片 ${imageIndex}`, dataUrl: `data:${entry.mimeType};base64,${entry.data}` });
        }
      }
    }
    const extracted = extractFileAttachments(text);
    return { text: extracted.text, attachments: [...attachments, ...extracted.attachments] };
  }

  private messageText(content: unknown): string {
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
    }).join("\n").trim();
  }
}
