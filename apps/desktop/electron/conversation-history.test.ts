import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { ProviderCatalogEntry, SubagentRunInfo, TaskFileChange } from "../src/contracts.js";
import type { SubagentRunStore } from "./subagent-run-store.js";
import { ConversationHistory, displayUserPrompt, extractFileAttachments, initProjectPrompt, type ConversationHistoryDeps } from "./conversation-history.js";

const temporaryDirectories: string[] = [];

function createDirectory(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-desktop-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function usage(input: number, output: number, cost: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant(content: AssistantMessage["content"], timestamp: number, model = "mock-model"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai-compatible",
    model,
    usage: usage(100, 10, 0.01),
    stopReason: "stop",
    timestamp,
  } as AssistantMessage;
}

function createDeps(overrides: Partial<ConversationHistoryDeps> = {}): ConversationHistoryDeps {
  return {
    isRunning: () => false,
    activeSession: () => undefined,
    disposeSession: () => {},
    modelCatalog: { getModelCatalog: async () => [] },
    fileChangeTracker: { restoreChange: () => {}, setLastChangeRunId: () => {} },
    subagentRuns: () => ({ findByToolCall: () => undefined }) as unknown as SubagentRunStore,
    subagentToolName: "subagent",
    ...overrides,
  };
}

function catalogWith(contextWindow: number): ConversationHistoryDeps["modelCatalog"] {
  return {
    getModelCatalog: async () => ([
      { id: "openai-compatible", models: [{ id: "mock-model", contextWindow }] },
    ] as unknown as ProviderCatalogEntry[]),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("displayUserPrompt", () => {
  it("collapses the init prompt to the slash command", () => {
    expect(displayUserPrompt(initProjectPrompt)).toBe("/init");
    expect(displayUserPrompt("hello")).toBe("hello");
  });
});

describe("extractFileAttachments", () => {
  it("strips well-formed trailing file blocks and keeps the remaining text", () => {
    expect(extractFileAttachments('do this\n\n<file name="a.txt">\nhello\n</file>')).toEqual({
      text: "do this",
      attachments: [{ kind: "file", name: "a.txt" }],
    });
    expect(extractFileAttachments('look\n\n<file name="a.txt">\nhello\n</file>\n\n<file name="b.md">\n# doc\n</file>')).toEqual({
      text: "look",
      attachments: [{ kind: "file", name: "a.txt" }, { kind: "file", name: "b.md" }],
    });
    expect(extractFileAttachments('\n\n<file name="only.txt">\ncontent\n</file>')).toEqual({
      text: "",
      attachments: [{ kind: "file", name: "only.txt" }],
    });
  });

  it("keeps non-trailing or malformed blocks in the text", () => {
    expect(extractFileAttachments('<file name="a.txt">\nhello\n</file>\n\nafter')).toEqual({
      text: '<file name="a.txt">\nhello\n</file>\n\nafter',
      attachments: [],
    });
    expect(extractFileAttachments('text\n\n<file name="a.txt">\nunclosed')).toEqual({
      text: 'text\n\n<file name="a.txt">\nunclosed',
      attachments: [],
    });
    expect(extractFileAttachments('prefix <file name="a.txt">\nhello\n</file>')).toEqual({
      text: 'prefix <file name="a.txt">\nhello\n</file>',
      attachments: [],
    });
  });

  it("rebuilds inline and on-demand attachment references with safe metadata", () => {
    const inlineId = "123e4567-e89b-42d3-a456-426614174000";
    const toolId = "123e4567-e89b-42d3-a456-426614174001";
    const text = `review\n\n<file attachment-id="${inlineId}" name="a&amp;b.txt" mime-type="text/plain" size="5" access="inline">\nhello\n</file>\n\n<attachment attachment-id="${toolId}" name="large.log" mime-type="text/plain" size="70000" access="read_attachment" />`;
    expect(extractFileAttachments(text)).toEqual({
      text: "review",
      attachments: [
        { kind: "file", name: "a&b.txt", id: inlineId, mimeType: "text/plain", size: 5, access: "inline" },
        { kind: "file", name: "large.log", id: toolId, mimeType: "text/plain", size: 70_000, access: "tool" },
      ],
    });
  });
});

describe("ConversationHistory", () => {
  it("lists conversations newest first with metadata and project info", async () => {
    const sessionDir = createDirectory("history-sessions");
    const fallbackCwd = createDirectory("history-fallback");
    const workspace = createDirectory("history-workspace");
    const older = SessionManager.create(workspace, sessionDir, { id: "conv-old" });
    older.appendMessage({ role: "user", content: "first question", timestamp: 1 } satisfies UserMessage);
    older.appendMessage(assistant([{ type: "text", text: "first answer" }], 2));
    older.appendCustomEntry("pi-desktop:conversation-metadata", { tags: ["work"], archived: true });
    const newer = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-new" });
    newer.appendMessage({ role: "user", content: "second question", timestamp: 3 } satisfies UserMessage);
    newer.appendMessage(assistant([{ type: "text", text: "second answer" }], 4));

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const items = await history.listConversations();

    expect(items.map((item) => item.id)).toEqual(["conv-new", "conv-old"]);
    const oldItem = items.find((item) => item.id === "conv-old")!;
    expect(oldItem).toMatchObject({ title: "first question", tags: ["work"], archived: true });
    expect(oldItem.project).toEqual({ id: workspace, name: path.basename(workspace), path: workspace });
    expect(items.find((item) => item.id === "conv-new")!.project).toBeUndefined();
  });

  it("pages and filters the rebuildable JSON conversation index", async () => {
    const sessionDir = createDirectory("history-index");
    const fallbackCwd = createDirectory("history-index-fallback");
    for (let index = 0; index < 5; index += 1) {
      const manager = SessionManager.create(fallbackCwd, sessionDir, { id: `indexed-${index}` });
      manager.appendMessage({ role: "user", content: `searchable conversation ${index}`, timestamp: index } satisfies UserMessage);
      manager.appendMessage(assistant([{ type: "text", text: `answer ${index}` }], index));
      if (index === 4) manager.appendCustomEntry("pi-desktop:conversation-metadata", { tags: ["important"], archived: true });
    }
    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const first = await history.listConversationPage({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    expect(first.total).toBe(5);
    const second = await history.listConversationPage({ cursor: first.nextCursor, limit: 2 });
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    await expect(history.listConversationPage({ query: "important", archived: true })).resolves.toMatchObject({
      total: 1,
      items: [{ id: "indexed-4", tags: ["important"], archived: true }],
    });

    fs.writeFileSync(path.join(sessionDir, "pi-desktop-conversation-index.v1.json"), "{broken");
    const rebuilt = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    await expect(rebuilt.listConversationPage({ limit: 10 })).resolves.toMatchObject({ total: 5 });
  });

  it("serves a bounded first page from a 1,000-session fixture", async () => {
    const sessionDir = createDirectory("history-index-scale");
    const fallbackCwd = createDirectory("history-index-scale-fallback");
    for (let index = 0; index < 1_000; index += 1) {
      const id = `scale-${String(index).padStart(4, "0")}`;
      const timestamp = new Date(1_700_000_000_000 + index).toISOString();
      const entries = [
        { type: "session", version: 3, id, timestamp, cwd: fallbackCwd },
        { type: "message", id: `${id}-user`, parentId: null, timestamp, message: { role: "user", content: `scale fixture ${index}`, timestamp: index } },
      ];
      fs.writeFileSync(path.join(sessionDir, `${id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    }
    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const first = await history.listConversationPage({ limit: 100 });
    expect(first).toMatchObject({ total: 1_000, nextCursor: "100" });
    expect(first.items).toHaveLength(100);
    await expect(history.listConversationPage({ query: "fixture 777" })).resolves.toMatchObject({ total: 1 });
  }, 20_000);

  it("rebuilds turns with activities, usage, file changes and context usage", async () => {
    const sessionDir = createDirectory("detail-sessions");
    const fallbackCwd = createDirectory("detail-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-detail" });
    manager.appendMessage(assistant([{ type: "text", text: "orphan" }], 1));
    manager.appendMessage({ role: "user", content: "inspect the project", timestamp: 2 } satisfies UserMessage);
    manager.appendMessage(assistant([
      { type: "thinking", thinking: "I should look" },
      { type: "toolCall", id: "call-ask", name: "ask_user", arguments: { question: "continue?", options: [{ label: "yes" }, { broken: true }] } },
      { type: "toolCall", id: "call-ask-text", name: "ask_user", arguments: {} },
      { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
      { type: "toolCall", id: "call-sub", name: "subagent", arguments: { task: "review" } },
    ], 3));
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-ask",
      toolName: "ask_user",
      content: [{ type: "text", text: "yes" }],
      isError: false,
      details: { answer: "definitely" },
      timestamp: 4,
    } as unknown as ToolResultMessage);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-ask-text",
      toolName: "ask_user",
      content: [{ type: "text", text: "User answered: sure" }],
      isError: false,
      timestamp: 5,
    } satisfies ToolResultMessage);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "readme contents" }],
      isError: true,
      timestamp: 6,
    } satisfies ToolResultMessage);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-sub",
      toolName: "subagent",
      content: "review done",
      isError: false,
      timestamp: 7,
    } as unknown as ToolResultMessage);
    const change: TaskFileChange = {
      id: "change-1",
      runId: "run-9",
      callId: "call-read",
      path: "/workspace/README.md",
      relativePath: "README.md",
      kind: "created",
      patch: "diff",
      afterHash: "abc",
      status: "pending",
      revertible: true,
    };
    manager.appendCustomEntry("pi-desktop:file-changes");
    manager.appendCustomEntry("pi-desktop:file-changes", { changes: [change, { broken: true }], runId: "run-9" });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "second question" }, { type: "image" }, "raw"], timestamp: 8 } as unknown as UserMessage);
    manager.appendMessage(assistant([
      { type: "text", text: "answer two" },
      { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "ls" } },
    ], 9));

    const restored: TaskFileChange[] = [];
    const runIds: string[] = [];
    const subagentRun = { id: "child-1", toolCallId: "call-sub", status: "completed" } as unknown as SubagentRunInfo;
    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps({
      modelCatalog: catalogWith(1000),
      fileChangeTracker: { restoreChange: (entry) => restored.push(entry), setLastChangeRunId: (runId) => runIds.push(runId) },
      subagentRuns: () => ({ findByToolCall: () => subagentRun }) as unknown as SubagentRunStore,
    }));
    const detail = await history.loadConversation("conv-detail");

    expect(detail.turns).toHaveLength(2);
    const [first, second] = detail.turns;
    expect(first.question).toBe("inspect the project");
    expect(first.usage).toMatchObject({ totalTokens: 110, requestCount: 1 });
    expect(first.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thinking", text: "I should look" }),
      expect.objectContaining({ type: "question", question: "continue?", answer: "definitely", status: "answered" }),
      expect.objectContaining({ type: "question", question: "Pi 需要你的回答", answer: "sure", status: "answered" }),
      expect.objectContaining({ type: "tool", name: "read", output: "readme contents", status: "error" }),
      expect.objectContaining({ type: "tool", name: "subagent", output: "review done", status: "success" }),
    ]));
    const question = first.activities.find((activity) => activity.type === "question");
    expect(question?.type === "question" && question.options).toEqual([{ label: "yes" }]);
    const subagentActivity = first.activities.find((activity) => activity.type === "tool" && activity.name === "subagent");
    expect(subagentActivity?.type === "tool" && subagentActivity.details?.subagent).toMatchObject({ id: "child-1" });
    expect(first.fileChanges).toHaveLength(1);
    expect(restored).toHaveLength(1);
    expect(runIds).toEqual(["run-9"]);

    expect(second.question).toBe("second question");
    expect(second.answer).toBe("answer two");
    expect(second.activities.find((activity) => activity.type === "tool")).toMatchObject({ name: "bash", status: "error" });
    expect(detail.contextUsage).toEqual({ tokens: 110, contextWindow: 1000, percent: 11 });
  });

  it("reports null tokens when the latest assistant reply predates a compaction", async () => {
    const sessionDir = createDirectory("compaction-sessions");
    const fallbackCwd = createDirectory("compaction-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-compaction" });
    const userEntryId = manager.appendMessage({ role: "user", content: "question", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "answer" }], 2));
    manager.appendCompaction("summary so far", userEntryId, 500);

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps({ modelCatalog: catalogWith(1000) }));
    const detail = await history.loadConversation("conv-compaction");
    expect(detail.contextUsage).toEqual({ tokens: null, contextWindow: 1000, percent: null });
  });

  it("falls back to fixed protocol metadata and omits context usage for unknown models", async () => {
    const sessionDir = createDirectory("fixed-sessions");
    const fallbackCwd = createDirectory("fixed-fallback");
    const known = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-fixed" });
    known.appendMessage({ role: "user", content: "question", timestamp: 1 } satisfies UserMessage);
    known.appendMessage(assistant([{ type: "text", text: "answer" }], 2, "gpt-5.6-sol"));
    const unknown = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-unknown" });
    unknown.appendMessage({ role: "user", content: "question", timestamp: 1 } satisfies UserMessage);
    unknown.appendMessage(assistant([{ type: "text", text: "answer" }], 2, "mystery-model"));

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const fixed = await history.loadConversation("conv-fixed");
    expect(fixed.contextUsage).toEqual({ tokens: 110, contextWindow: 1_050_000, percent: (110 / 1_050_000) * 100 });
    const missing = await history.loadConversation("conv-unknown");
    expect(missing.contextUsage).toBeUndefined();
  });

  it("rejects loading an unknown conversation", async () => {
    const sessionDir = createDirectory("missing-sessions");
    const history = new ConversationHistory(sessionDir, createDirectory("missing-fallback"), createDeps());
    await expect(history.loadConversation("nope")).rejects.toThrow("找不到该会话");
  });

  it("rebuilds image and file attachments from stored user messages", async () => {
    const sessionDir = createDirectory("attachments-sessions");
    const fallbackCwd = createDirectory("attachments-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-attachments" });
    manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: 'look at this\n\n<file name="notes.txt">\nsome notes\n</file>' },
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "image" },
      ],
      timestamp: 1,
    } as unknown as UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "answer" }], 2));

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const detail = await history.loadConversation("conv-attachments");

    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].question).toBe("look at this");
    expect(detail.turns[0].attachments).toEqual([
      { kind: "image", name: "图片 1", dataUrl: "data:image/png;base64,QUJD" },
      { kind: "file", name: "notes.txt" },
    ]);
  });

  it("forks a conversation and copies its tags", async () => {
    const sessionDir = createDirectory("fork-sessions");
    const fallbackCwd = createDirectory("fork-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-fork" });
    manager.appendMessage({ role: "user", content: "original question", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "answer" }], 2));
    manager.appendCustomEntry("pi-desktop:conversation-metadata", { tags: ["kept"], archived: true });

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const forked = await history.forkConversation("conv-fork");

    expect(forked.id).not.toBe("conv-fork");
    expect(forked.title).toBe("Fork · original question");
    expect(forked.tags).toEqual(["kept"]);
    expect(forked.archived).toBe(false);
    expect(forked.parentConversationId).toBe("conv-fork");
    expect((await history.listConversations())).toHaveLength(2);
  });

  it("forks from a selected entry and validates preconditions", async () => {
    const sessionDir = createDirectory("fork-entry-sessions");
    const fallbackCwd = createDirectory("fork-entry-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-partial" });
    const userEntryId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "first answer" }], 2));
    manager.appendMessage({ role: "user", content: "second", timestamp: 3 } satisfies UserMessage);

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    await expect(history.forkConversation("conv-partial", "missing-entry")).rejects.toThrow("选择的会话节点不存在");

    const forked = await history.forkConversation("conv-partial", userEntryId);
    const detail = await history.loadConversation(forked.id);
    expect(detail.turns.map((turn) => turn.question)).toEqual(["first"]);
    expect(detail.turns[0].answer).toBe("first answer");

    const busy = new ConversationHistory(sessionDir, fallbackCwd, createDeps({ isRunning: () => true }));
    await expect(busy.forkConversation("conv-partial")).rejects.toThrow("Agent 正在执行");
    await expect(history.forkConversation("nope")).rejects.toThrow("找不到该会话");
  });

  it("exports conversations as sanitized markdown and json", async () => {
    const sessionDir = createDirectory("export-sessions");
    const fallbackCwd = createDirectory("export-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-export" });
    manager.appendMessage({ role: "user", content: "a/b: c?", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "thinking", thinking: "only thinking" }], 2));
    manager.appendCustomEntry("pi-desktop:conversation-metadata", { tags: ["tagged"], archived: false });

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const markdown = await history.exportConversation("conv-export", "markdown");
    expect(markdown.filename).toBe("a-b- c-.md");
    expect(markdown.mimeType).toBe("text/markdown");
    expect(markdown.content).toContain("# a/b: c?");
    expect(markdown.content).toContain("- Tags: tagged");
    expect(markdown.content).toContain("_(No text response)_");

    const json = await history.exportConversation("conv-export", "json");
    expect(json.filename).toBe("a-b- c-.json");
    expect(JSON.parse(json.content).id).toBe("conv-export");
  });

  it("validates and normalizes tags and archive state", async () => {
    const sessionDir = createDirectory("tags-sessions");
    const fallbackCwd = createDirectory("tags-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-tags" });
    manager.appendMessage({ role: "user", content: "question", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "answer" }], 2));

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    await history.setConversationTags("conv-tags", ["  a   b  ", "a b", "", "x"]);
    await history.setConversationArchived("conv-tags", true);
    const detail = await history.loadConversation("conv-tags");
    expect(detail.tags).toEqual(["a b", "x"]);
    expect(detail.archived).toBe(true);

    await expect(history.setConversationTags("conv-tags", Array.from({ length: 9 }, (_, index) => `tag-${index}`))).rejects.toThrow("最多设置 8 个标签");
    await expect(history.setConversationTags("conv-tags", ["x".repeat(25)])).rejects.toThrow("最多设置 8 个标签");

    const busy = new ConversationHistory(sessionDir, fallbackCwd, createDeps({ isRunning: () => true }));
    await expect(busy.setConversationArchived("conv-tags", false)).rejects.toThrow("Agent 正在执行");
  });

  it("renames conversations with validation and active-session support", async () => {
    const sessionDir = createDirectory("rename-sessions");
    const fallbackCwd = createDirectory("rename-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-rename" });
    manager.appendMessage({ role: "user", content: "original", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "answer" }], 2));

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    await expect(history.renameConversation("conv-rename", "   ")).rejects.toThrow("不能为空");
    await expect(history.renameConversation("conv-rename", "x".repeat(61))).rejects.toThrow("不能超过 60 个字符");
    await expect(history.renameConversation("nope", "title")).rejects.toThrow("找不到该会话");

    await history.renameConversation("conv-rename", "  new   title  ");
    expect((await history.listConversations())[0].title).toBe("new title");

    const setSessionName = vi.fn();
    const active = new ConversationHistory(sessionDir, fallbackCwd, createDeps({
      activeSession: () => ({
        sessionManager: { getSessionId: () => "conv-rename" },
        setSessionName,
      }) as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
    }));
    await active.renameConversation("conv-rename", "active title");
    expect(setSessionName).toHaveBeenCalledWith("active title");

    const busy = new ConversationHistory(sessionDir, fallbackCwd, createDeps({ isRunning: () => true }));
    await expect(busy.renameConversation("conv-rename", "title")).rejects.toThrow("Agent 正在执行");
  });

  it("deletes conversations and disposes a matching active session", async () => {
    const sessionDir = createDirectory("delete-sessions");
    const fallbackCwd = createDirectory("delete-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-delete" });
    manager.appendMessage({ role: "user", content: "question", timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "answer" }], 2));

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    await expect(history.deleteConversation("nope")).rejects.toThrow("找不到该会话");
    const busy = new ConversationHistory(sessionDir, fallbackCwd, createDeps({ isRunning: () => true }));
    await expect(busy.deleteConversation("conv-delete")).rejects.toThrow("Agent 正在执行");

    const disposeSession = vi.fn();
    const active = new ConversationHistory(sessionDir, fallbackCwd, createDeps({
      disposeSession,
      activeSession: () => ({
        sessionManager: { getSessionId: () => "conv-delete" },
      }) as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
    }));
    await active.deleteConversation("conv-delete");
    expect(disposeSession).toHaveBeenCalledTimes(1);
    expect(await active.listConversations()).toHaveLength(0);
  });

  it("truncates long titles when listing conversations", async () => {
    const sessionDir = createDirectory("title-sessions");
    const fallbackCwd = createDirectory("title-fallback");
    const manager = SessionManager.create(fallbackCwd, sessionDir, { id: "conv-title" });
    manager.appendMessage({ role: "user", content: "x".repeat(80), timestamp: 1 } satisfies UserMessage);
    manager.appendMessage(assistant([{ type: "text", text: "answer" }], 2));

    const history = new ConversationHistory(sessionDir, fallbackCwd, createDeps());
    const [item] = await history.listConversations();
    expect(item.title).toHaveLength(61);
    expect(item.title.endsWith("…")).toBe(true);
  });
});
