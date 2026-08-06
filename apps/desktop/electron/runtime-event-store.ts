import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  runtimeProtocolVersion,
  runtimeEventTypes,
  validateRuntimeServerEnvelope,
  type AgentEvent,
  type RuntimeEventCheckpoint,
  type RuntimeEventPage,
  type RuntimeEventQuery,
  type RuntimeEventRecord,
  type RuntimeReplayRun,
  type RuntimeReplaySnapshot,
  type RuntimeReplayTool,
  type RuntimeReplayTurn,
} from "@pi-forge/runtime-contracts";

const schemaVersion = 1 as const;
const eventFileName = "events.v1.jsonl";
const legacyEventFileName = "events.jsonl";
const manifestFileName = "manifest.json";
const checkpointFileName = "checkpoints.v1.json";
const maxQueryLimit = 1_000;
const knownEventTypes = new Set<string>(runtimeEventTypes);

type Manifest = { schemaVersion: 1; eventFile: typeof eventFileName };
type CheckpointFile = { schemaVersion: 1; checkpoints: RuntimeEventCheckpoint[] };
type LegacyRuntimeEventRecord = {
  schemaVersion?: 0;
  offset?: number;
  sequence?: number;
  recordedAt?: string;
  timestamp?: string | number;
  event: AgentEvent;
};

type EventScope = {
  conversationId?: string;
  runId?: string;
  turnId?: string;
  toolCallId?: string;
};

function atomicWrite(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  const descriptor = fs.openSync(temporaryPath, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporaryPath, filePath);
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label}无效。`);
  return value as number;
}

function validateEvent(value: unknown): AgentEvent {
  const result = validateRuntimeServerEnvelope({
    kind: "runtime.event",
    protocolVersion: runtimeProtocolVersion,
    event: value,
  });
  if (!result.success || result.value.kind !== "runtime.event") throw new Error("Runtime 事件日志包含无效事件。");
  return result.value.event;
}

function parseTimestamp(value: unknown, fallback: number): string {
  const timestamp = typeof value === "number" ? new Date(value) : new Date(typeof value === "string" ? value : fallback);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Runtime 事件时间戳无效。");
  return timestamp.toISOString();
}

function queryIdentifier(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${label}无效。`);
  return normalized;
}

/**
 * Append-only, versioned Runtime event journal owned by Electron Main.
 * Every acknowledged record is fsynced before it is exposed to query callers.
 */
export class RuntimeEventStore {
  private readonly records: RuntimeEventRecord[] = [];
  private readonly checkpoints = new Map<string, RuntimeEventCheckpoint>();
  private readonly runConversations = new Map<string, string>();
  private readonly runTurns = new Map<string, string>();
  private readonly runTurnCounts = new Map<string, number>();
  private readonly openTurns = new Set<string>();
  private nextOffset = 1;
  private readonly eventPath: string;

  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = randomUUID,
  ) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.eventPath = path.join(directory, eventFileName);
    this.loadOrMigrate();
    this.loadCheckpoints();
  }

  record(eventInput: AgentEvent): RuntimeEventRecord {
    const event = validateEvent(eventInput);
    const scope = this.inferScope(event);
    const offset = this.nextOffset;
    const record: RuntimeEventRecord = {
      schemaVersion,
      offset,
      eventId: this.id(),
      recordedAt: new Date(this.now()).toISOString(),
      ...scope,
      event,
    };
    this.append(record);
    this.records.push(record);
    this.nextOffset = offset + 1;
    return record;
  }

  query(input: RuntimeEventQuery = {}): RuntimeEventPage {
    const query = this.normalizeQuery(input);
    const matches = this.records.filter((record) => this.matches(record, query));
    const events = matches.slice(0, query.limit);
    return {
      events,
      nextOffset: events.at(-1)?.offset ?? query.afterOffset,
      highWatermark: this.highWatermark(),
      hasMore: matches.length > events.length,
    };
  }

  replay(input: RuntimeEventQuery = {}): RuntimeReplaySnapshot {
    const query = this.normalizeQuery({ ...input, limit: maxQueryLimit });
    const records = this.records.filter((record) => this.matches(record, { ...query, limit: Number.MAX_SAFE_INTEGER }));
    return replayRuntimeEventRecords(records, query.afterOffset, this.highWatermark());
  }

  saveCheckpoint(nameInput: string, offsetInput = this.highWatermark()): RuntimeEventCheckpoint {
    const name = nameInput.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) throw new Error("Runtime checkpoint 名称无效。");
    if (!Number.isSafeInteger(offsetInput) || offsetInput < 0 || offsetInput > this.highWatermark()) {
      throw new Error("Runtime checkpoint offset 无效。");
    }
    const checkpoint: RuntimeEventCheckpoint = {
      schemaVersion,
      name,
      offset: offsetInput,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.checkpoints.set(name, checkpoint);
    this.persistCheckpoints();
    return checkpoint;
  }

  listCheckpoints(): RuntimeEventCheckpoint[] {
    return [...this.checkpoints.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  highWatermark(): number {
    return this.nextOffset - 1;
  }

  private normalizeQuery(input: RuntimeEventQuery): Required<Pick<RuntimeEventQuery, "afterOffset" | "limit">> & RuntimeEventQuery {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Runtime 事件查询无效。");
    const afterOffset = input.afterOffset ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(afterOffset) || afterOffset < 0) throw new Error("Runtime 事件 offset 无效。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxQueryLimit) throw new Error("Runtime 事件查询数量无效。");
    if (input.eventTypes !== undefined && (!Array.isArray(input.eventTypes) || input.eventTypes.length > 64
      || input.eventTypes.some((eventType) => typeof eventType !== "string" || !knownEventTypes.has(eventType)))) {
      throw new Error("Runtime 事件类型过滤无效。");
    }
    return {
      ...input,
      conversationId: queryIdentifier(input.conversationId, "会话 ID"),
      runId: queryIdentifier(input.runId, "运行 ID"),
      turnId: queryIdentifier(input.turnId, "轮次 ID"),
      toolCallId: queryIdentifier(input.toolCallId, "工具调用 ID"),
      eventTypes: input.eventTypes ? [...new Set(input.eventTypes)] : undefined,
      afterOffset,
      limit,
    };
  }

  private matches(record: RuntimeEventRecord, query: RuntimeEventQuery & { afterOffset: number }): boolean {
    return record.offset > query.afterOffset
      && (query.conversationId === undefined || record.conversationId === query.conversationId)
      && (query.runId === undefined || record.runId === query.runId)
      && (query.turnId === undefined || record.turnId === query.turnId)
      && (query.toolCallId === undefined || record.toolCallId === query.toolCallId)
      && (query.eventTypes === undefined || query.eventTypes.includes(record.event.type));
  }

  private append(record: RuntimeEventRecord): void {
    const descriptor = fs.openSync(this.eventPath, "a", 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private loadOrMigrate(): void {
    const manifestPath = path.join(this.directory, manifestFileName);
    const legacyPath = path.join(this.directory, legacyEventFileName);
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<Manifest>;
      if (manifest.schemaVersion !== schemaVersion || manifest.eventFile !== eventFileName) {
        throw new Error(`不支持的 Runtime 事件存储版本：${String(manifest.schemaVersion)}。`);
      }
      this.loadCurrentLog();
      return;
    }

    if (fs.existsSync(legacyPath)) {
      const legacyRows = this.readJsonLines(legacyPath);
      let fallbackOffset = 1;
      for (const value of legacyRows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("旧版 Runtime 事件日志无效。");
        const legacy = value as LegacyRuntimeEventRecord;
        const event = validateEvent(legacy.event);
        const offset = requiredPositiveInteger(legacy.offset ?? legacy.sequence ?? fallbackOffset, "旧版 Runtime 事件 offset");
        if (offset < fallbackOffset) throw new Error("旧版 Runtime 事件 offset 未单调递增。");
        fallbackOffset = offset + 1;
        const record: RuntimeEventRecord = {
          schemaVersion,
          offset,
          eventId: `migrated-${offset}`,
          recordedAt: parseTimestamp(legacy.recordedAt ?? legacy.timestamp, this.now()),
          ...this.inferScope(event),
          event,
        };
        this.records.push(record);
      }
      this.rewriteLog();
      fs.renameSync(legacyPath, `${legacyPath}.migrated-v0`);
    } else if (fs.existsSync(this.eventPath)) {
      // A migration can be interrupted after the v1 log is fsynced but before
      // its manifest is renamed. Recover that log instead of reusing offset 1.
      this.loadCurrentLog();
    } else {
      fs.closeSync(fs.openSync(this.eventPath, "a", 0o600));
    }
    this.nextOffset = (this.records.at(-1)?.offset ?? 0) + 1;
    atomicWrite(manifestPath, { schemaVersion, eventFile: eventFileName } satisfies Manifest);
  }

  private loadCurrentLog(): void {
    if (!fs.existsSync(this.eventPath)) throw new Error("Runtime 事件存储 manifest 指向的日志不存在。");
    let previousOffset = 0;
    for (const value of this.readJsonLines(this.eventPath)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime 事件日志记录无效。");
      const input = value as Partial<RuntimeEventRecord>;
      if (input.schemaVersion !== schemaVersion || typeof input.eventId !== "string" || !input.eventId
        || typeof input.recordedAt !== "string" || !Number.isFinite(Date.parse(input.recordedAt))) {
        throw new Error("Runtime 事件日志记录版本或元数据无效。");
      }
      const offset = requiredPositiveInteger(input.offset, "Runtime 事件 offset");
      if (offset <= previousOffset) throw new Error("Runtime 事件 offset 未单调递增。");
      previousOffset = offset;
      const event = validateEvent(input.event);
      const inferred = this.inferScope(event);
      const record: RuntimeEventRecord = {
        schemaVersion,
        offset,
        eventId: input.eventId,
        recordedAt: new Date(input.recordedAt).toISOString(),
        conversationId: input.conversationId ?? inferred.conversationId,
        runId: input.runId ?? inferred.runId,
        turnId: input.turnId ?? inferred.turnId,
        toolCallId: input.toolCallId ?? inferred.toolCallId,
        event,
      };
      this.records.push(record);
    }
    this.nextOffset = previousOffset + 1;
  }

  private readJsonLines(filePath: string): unknown[] {
    const source = fs.readFileSync(filePath, "utf8");
    const lines = source.split("\n");
    const values: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch (error) {
        const finalNonEmpty = lines.slice(index + 1).every((entry) => !entry.trim());
        if (finalNonEmpty) {
          fs.truncateSync(filePath, Buffer.byteLength(lines.slice(0, index).join("\n") + (index > 0 ? "\n" : ""), "utf8"));
          break;
        }
        throw new Error("Runtime 事件日志中间包含损坏记录。", { cause: error });
      }
    }
    return values;
  }

  private rewriteLog(): void {
    const temporaryPath = `${this.eventPath}.tmp`;
    const body = this.records.map((record) => JSON.stringify(record)).join("\n");
    fs.writeFileSync(temporaryPath, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
    const descriptor = fs.openSync(temporaryPath, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporaryPath, this.eventPath);
  }

  private inferScope(event: AgentEvent): EventScope {
    const runId = "runId" in event ? event.runId : undefined;
    let conversationId = "conversationId" in event ? event.conversationId : undefined;
    if (event.type === "run.started") this.runConversations.set(event.runId, event.conversationId);
    if (!conversationId && runId) conversationId = this.runConversations.get(runId);

    if (runId && event.type === "agent.event" && event.event.eventType === "turn_start") this.startTurn(runId);
    if (runId && event.type === "user.message.started" && !this.openTurns.has(runId)) this.startTurn(runId);
    const turnId = runId ? this.runTurns.get(runId) : undefined;
    const toolCallId = "callId" in event ? event.callId : undefined;

    if (runId && ((event.type === "agent.event" && event.event.eventType === "turn_end")
      || event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.error")) {
      this.openTurns.delete(runId);
    }
    return { conversationId, runId, turnId, toolCallId };
  }

  private startTurn(runId: string): void {
    const count = (this.runTurnCounts.get(runId) ?? 0) + 1;
    this.runTurnCounts.set(runId, count);
    this.runTurns.set(runId, `${runId}:turn:${count}`);
    this.openTurns.add(runId);
  }

  private loadCheckpoints(): void {
    const filePath = path.join(this.directory, checkpointFileName);
    if (!fs.existsSync(filePath)) return;
    const input = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CheckpointFile>;
    if (input.schemaVersion !== schemaVersion || !Array.isArray(input.checkpoints)) throw new Error("Runtime checkpoint 文件无效。");
    for (const checkpoint of input.checkpoints) {
      if (checkpoint.schemaVersion !== schemaVersion || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(checkpoint.name)
        || !Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0 || checkpoint.offset > this.highWatermark()
        || !Number.isFinite(Date.parse(checkpoint.updatedAt))) {
        throw new Error("Runtime checkpoint 记录无效。");
      }
      this.checkpoints.set(checkpoint.name, checkpoint);
    }
  }

  private persistCheckpoints(): void {
    atomicWrite(path.join(this.directory, checkpointFileName), {
      schemaVersion,
      checkpoints: this.listCheckpoints(),
    } satisfies CheckpointFile);
  }
}

export function replayRuntimeEventRecords(
  records: readonly RuntimeEventRecord[],
  afterOffset = 0,
  highWatermark = records.at(-1)?.offset ?? 0,
): RuntimeReplaySnapshot {
  const runs = new Map<string, RuntimeReplayRun>();
  const turns = new Map<string, RuntimeReplayTurn>();
  const tools = new Map<string, RuntimeReplayTool>();

  for (const record of records) {
    const { event } = record;
    if (!record.runId) continue;
    let run = runs.get(record.runId);
    if (!run) {
      run = {
        runId: record.runId,
        conversationId: record.conversationId,
        status: "running",
        turns: [],
        startedOffset: record.offset,
      };
      runs.set(record.runId, run);
    }
    if (!run.conversationId && record.conversationId) run.conversationId = record.conversationId;
    if (event.type === "run.started") {
      run.provider = event.provider;
      run.model = event.model;
      run.cwd = event.cwd;
    }

    let turn: RuntimeReplayTurn | undefined;
    if (record.turnId) {
      turn = turns.get(record.turnId);
      if (!turn) {
        turn = {
          turnId: record.turnId,
          runId: record.runId,
          assistantText: "",
          thinkingText: "",
          tools: [],
          startedOffset: record.offset,
        };
        turns.set(record.turnId, turn);
        run.turns.push(turn);
      }
    }

    if (turn && event.type === "user.message.started") turn.userMessage = event.message;
    else if (turn && event.type === "message.delta") turn.assistantText += event.text;
    else if (turn && event.type === "thinking.delta") turn.thinkingText += event.text;

    if (turn && record.toolCallId && (event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.completed")) {
      const key = `${record.runId}:${record.toolCallId}`;
      let tool = tools.get(key);
      if (!tool) {
        tool = {
          callId: record.toolCallId,
          name: event.name,
          status: "running",
          startedOffset: record.offset,
        };
        tools.set(key, tool);
        turn.tools.push(tool);
      }
      if (event.type === "tool.started") tool.args = event.args;
      else {
        tool.output = event.output;
        tool.details = event.details;
        if (event.type === "tool.completed") {
          tool.status = event.isError ? "error" : "completed";
          tool.completedOffset = record.offset;
        }
      }
    }

    if (event.type === "agent.event" && event.event.eventType === "turn_end" && turn) turn.completedOffset = record.offset;
    if (event.type === "run.completed" || event.type === "run.stopped" || event.type === "run.error") {
      run.status = event.type === "run.completed" ? "completed" : event.type === "run.stopped" ? "stopped" : "error";
      if (event.type === "run.error") run.error = event.message;
      run.completedOffset = record.offset;
      if (turn && turn.completedOffset === undefined) turn.completedOffset = record.offset;
    }
  }

  return { schemaVersion, afterOffset, highWatermark, runs: [...runs.values()] };
}
