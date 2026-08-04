import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationHistoryItem, ConversationHistoryPage, ConversationListQuery } from "../src/contracts.js";
import { displayUserPrompt } from "./conversation-history.js";

const indexVersion = 1;
const indexFilename = "pi-desktop-conversation-index.v1.json";
const maxSearchTextLength = 200_000;

type IndexedConversation = {
  sessionPath: string;
  parentSessionPath?: string;
  mtimeMs: number;
  size: number;
  item: ConversationHistoryItem;
};

type PersistedIndex = {
  version: typeof indexVersion;
  sessions: IndexedConversation[];
};

type ConversationCursor = { updatedAt: string; id: string };

function encodeCursor(record: IndexedConversation): string {
  return `v1:${Buffer.from(JSON.stringify({ updatedAt: record.item.updatedAt, id: record.item.id } satisfies ConversationCursor)).toString("base64url")}`;
}

function decodeCursor(value: string | undefined): ConversationCursor | undefined {
  if (!value?.startsWith("v1:")) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as Partial<ConversationCursor>;
    return typeof parsed.updatedAt === "string" && typeof parsed.id === "string"
      ? { updatedAt: parsed.updatedAt, id: parsed.id }
      : undefined;
  } catch {
    return undefined;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.text === "string") return [record.text];
    if (typeof record.thinking === "string") return [record.thinking];
    if (typeof record.name === "string") return [record.name];
    return [];
  }).join("\n");
}

function validRecord(value: unknown): value is IndexedConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<IndexedConversation>;
  return typeof record.sessionPath === "string"
    && typeof record.mtimeMs === "number"
    && typeof record.size === "number"
    && Boolean(record.item)
    && typeof record.item?.id === "string"
    && typeof record.item?.updatedAt === "string";
}

export class ConversationIndexStore {
  private records: IndexedConversation[] | undefined;
  private syncing: Promise<IndexedConversation[]> | undefined;
  private generation = 0;

  constructor(
    private readonly sessionDir: string,
    private readonly fallbackCwd: string,
  ) {}

  invalidate(): void {
    this.generation += 1;
    this.records = undefined;
  }

  async listAll(): Promise<ConversationHistoryItem[]> {
    return (await this.sync()).map((record) => record.item);
  }

  async page(query: ConversationListQuery = {}): Promise<ConversationHistoryPage> {
    const normalizedQuery = query.query?.trim().toLocaleLowerCase() ?? "";
    const filtered = (await this.sync()).filter(({ item }) => {
      if (query.archived !== undefined && item.archived !== query.archived) return false;
      if (query.projectId !== undefined && item.project?.id !== query.projectId) return false;
      return !normalizedQuery || [item.title, item.cwd, item.searchText, ...item.tags]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
    const cursor = decodeCursor(query.cursor);
    const legacyOffset = query.cursor && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0;
    const cursorOffset = cursor
      ? filtered.findIndex(({ item }) => item.updatedAt < cursor.updatedAt || (item.updatedAt === cursor.updatedAt && item.id > cursor.id))
      : undefined;
    const offset = cursorOffset === undefined ? legacyOffset : cursorOffset < 0 ? filtered.length : cursorOffset;
    const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 100)));
    const end = Math.min(filtered.length, offset + limit);
    return {
      items: filtered.slice(offset, end).map((record) => record.item),
      nextCursor: end < filtered.length ? encodeCursor(filtered[end - 1]) : undefined,
      total: filtered.length,
    };
  }

  async find(conversationId: string): Promise<IndexedConversation | undefined> {
    return (await this.sync()).find((record) => record.item.id === conversationId);
  }

  private async sync(): Promise<IndexedConversation[]> {
    if (this.syncing) return this.syncing;
    const syncing = this.syncUntilCurrent().finally(() => {
      if (this.syncing === syncing) this.syncing = undefined;
    });
    this.syncing = syncing;
    return syncing;
  }

  private async syncUntilCurrent(): Promise<IndexedConversation[]> {
    while (true) {
      const generation = this.generation;
      const records = await this.syncOnce(generation);
      if (generation === this.generation) return records;
    }
  }

  private async syncOnce(generation: number): Promise<IndexedConversation[]> {
    const previous = this.records ?? await this.readPersisted();
    const previousByPath = new Map(previous.map((record) => [path.resolve(record.sessionPath), record]));
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(this.sessionDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next: IndexedConversation[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionPath = path.join(this.sessionDir, entry.name);
      try {
        const stat = await fs.promises.stat(sessionPath);
        const cached = previousByPath.get(path.resolve(sessionPath));
        next.push(cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
          ? cached
          : this.readSession(sessionPath, stat));
      } catch {
        // A malformed or concurrently deleted session is skipped; its JSONL remains untouched.
      }
    }
    const idsByPath = new Map(next.map((record) => [path.resolve(record.sessionPath), record.item.id]));
    for (const record of next) {
      record.item.parentConversationId = record.parentSessionPath
        ? idsByPath.get(path.resolve(record.parentSessionPath))
        : undefined;
    }
    next.sort((left, right) => right.item.updatedAt.localeCompare(left.item.updatedAt) || left.item.id.localeCompare(right.item.id));
    const changed = previous.length !== next.length || next.some((record, index) => {
      const existing = previous[index];
      return !existing
        || existing.sessionPath !== record.sessionPath
        || existing.mtimeMs !== record.mtimeMs
        || existing.size !== record.size
        || existing.item.parentConversationId !== record.item.parentConversationId;
    });
    if (generation !== this.generation) return next;
    this.records = next;
    if (changed) {
      try {
        await this.persist(next);
      } catch {
        // The JSON index is only a cache. Read-only filesystems and failed
        // atomic replacements must not make valid session JSONL unreadable.
      }
    }
    return next;
  }

  private readSession(sessionPath: string, stat: fs.Stats): IndexedConversation {
    const manager = SessionManager.open(sessionPath, this.sessionDir, this.fallbackCwd);
    const header = manager.getHeader();
    if (!header) throw new Error("会话文件缺少 header。");
    const entries = manager.getEntries();
    const metadataEntry = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-desktop:conversation-metadata").at(-1);
    const metadata = metadataEntry?.type === "custom" && metadataEntry.data && typeof metadataEntry.data === "object"
      ? metadataEntry.data as Record<string, unknown>
      : {};
    const messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message as unknown as Record<string, unknown>] : []);
    const firstMessage = messages.find((message) => message.role === "user");
    const firstText = contentText(firstMessage?.content);
    const cwd = header.cwd || this.fallbackCwd;
    const isProject = path.resolve(cwd) !== path.resolve(this.fallbackCwd);
    const rawTitle = manager.getSessionName()?.trim() || displayUserPrompt(firstText).trim().replace(/\s+/g, " ") || "未命名对话";
    return {
      sessionPath,
      parentSessionPath: header.parentSession,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      item: {
        id: header.id,
        title: rawTitle.length > 60 ? `${rawTitle.slice(0, 60)}…` : rawTitle,
        cwd,
        createdAt: header.timestamp,
        updatedAt: stat.mtime.toISOString(),
        tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8) : [],
        archived: metadata.archived === true,
        searchText: messages.map((message) => contentText(message.content)).join("\n").slice(0, maxSearchTextLength),
        project: isProject ? { id: cwd, name: path.basename(cwd), path: cwd } : undefined,
      },
    };
  }

  private async readPersisted(): Promise<IndexedConversation[]> {
    try {
      const value = JSON.parse(await fs.promises.readFile(path.join(this.sessionDir, indexFilename), "utf8")) as Partial<PersistedIndex>;
      return value.version === indexVersion && Array.isArray(value.sessions) && value.sessions.every(validRecord) ? value.sessions : [];
    } catch {
      return [];
    }
  }

  private async persist(records: IndexedConversation[]): Promise<void> {
    await fs.promises.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.sessionDir, indexFilename);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify({ version: indexVersion, sessions: records } satisfies PersistedIndex), { mode: 0o600 });
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
