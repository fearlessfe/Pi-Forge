import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SendPromptInput } from "../src/contracts.js";
import type { RuntimeRecoveryRecord } from "./agent-runtime-protocol.js";

type StoredRecoveryFile = { version: 1; records: RuntimeRecoveryRecord[] };

function validInput(value: unknown): value is SendPromptInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.prompt === "string"
    && (input.cwd === undefined || typeof input.cwd === "string")
    && (input.conversationId === undefined || typeof input.conversationId === "string");
}

function parseRecord(value: unknown): RuntimeRecoveryRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || !validInput(record.input)
    || (record.status !== "starting" && record.status !== "running" && record.status !== "interrupted")
    || typeof record.attempts !== "number"
    || typeof record.startedAt !== "string"
    || typeof record.updatedAt !== "string"
  ) return undefined;
  return {
    id: record.id,
    runId: typeof record.runId === "string" ? record.runId : undefined,
    input: { ...record.input },
    status: record.status,
    attempts: Math.max(1, Math.floor(record.attempts)),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

export class RuntimeRecoveryStore {
  private readonly filePath: string;
  private records: RuntimeRecoveryRecord[];

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "runtime-recovery.json");
    this.records = this.read().map((record) => record.status === "interrupted" ? record : {
      ...record,
      status: "interrupted" as const,
      updatedAt: new Date().toISOString(),
      message: "Pi Forge 上次退出时任务仍在运行。请检查工作区状态后继续。",
    });
    if (this.records.length > 0) this.persist();
  }

  begin(input: SendPromptInput): RuntimeRecoveryRecord {
    const now = new Date().toISOString();
    const record: RuntimeRecoveryRecord = {
      id: randomUUID(),
      input: { ...input, prompt: input.prompt.trim() },
      status: "starting",
      attempts: 1,
      startedAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    this.persist();
    return { ...record, input: { ...record.input } };
  }

  attachRun(id: string, runId: string): void {
    this.update(id, { runId, status: "running", message: undefined });
  }

  completeRun(runId: string): void {
    const next = this.records.filter((record) => record.runId !== runId);
    if (next.length === this.records.length) return;
    this.records = next;
    this.persist();
  }

  interruptRun(runId: string, message: string): void {
    let changed = false;
    this.records = this.records.map((record) => {
      if (record.status === "interrupted" || record.runId !== runId) return record;
      changed = true;
      return { ...record, status: "interrupted", message, updatedAt: new Date().toISOString() };
    });
    if (changed) this.persist();
  }

  interruptRecord(id: string, message: string): void {
    this.update(id, { status: "interrupted", message });
  }

  discard(id: string): void {
    const next = this.records.filter((record) => record.id !== id);
    if (next.length === this.records.length) throw new Error("找不到待恢复任务。");
    this.records = next;
    this.persist();
  }

  discardConversation(conversationId: string): void {
    const next = this.records.filter((record) => record.input.conversationId !== conversationId);
    if (next.length === this.records.length) return;
    this.records = next;
    this.persist();
  }

  get(id: string): RuntimeRecoveryRecord {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) throw new Error("找不到待恢复任务。");
    return { ...record, input: { ...record.input } };
  }

  list(): RuntimeRecoveryRecord[] {
    return this.records.filter((record) => record.status === "interrupted")
      .map((record) => ({ ...record, input: { ...record.input } }));
  }

  private update(id: string, patch: Partial<RuntimeRecoveryRecord>): void {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return;
    this.records[index] = { ...this.records[index], ...patch, updatedAt: new Date().toISOString() };
    this.persist();
  }

  private read(): RuntimeRecoveryRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredRecoveryFile>;
      if (stored.version !== 1 || !Array.isArray(stored.records)) return [];
      return stored.records.map(parseRecord).filter((record): record is RuntimeRecoveryRecord => Boolean(record));
    } catch {
      return [];
    }
  }

  private persist(): void {
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, records: this.records } satisfies StoredRecoveryFile, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
