import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ResponseUsage, SubagentRunInfo } from "../src/contracts.js";

type StoredIndexV1 = {
  version: 1;
  runs: unknown[];
};

type StoredIndexV2 = {
  version: 2;
  runs: SubagentRunInfo[];
};

type CreateSubagentRun = Omit<
  SubagentRunInfo,
  "id" | "status" | "attempt" | "queuedAt" | "startedAt" | "updatedAt" | "completedAt" | "result" | "usage" | "error"
>;

type UpdateSubagentRun = Partial<Omit<SubagentRunInfo, "id" | "startedAt">>;
type CompleteSubagentRun = { result?: string; usage?: ResponseUsage };

const validStatuses = new Set<SubagentRunInfo["status"]>([
  "queued",
  "running",
  "paused",
  "completed",
  "error",
  "stopped",
]);
const v1Statuses = new Set(["running", "completed", "error", "stopped"]);
const terminalStatuses = new Set<SubagentRunInfo["status"]>(["completed", "error", "stopped"]);

const allowedTransitions: Record<SubagentRunInfo["status"], ReadonlySet<SubagentRunInfo["status"]>> = {
  queued: new Set(["running", "paused", "stopped"]),
  running: new Set(["paused", "completed", "error", "stopped"]),
  paused: new Set(["queued", "stopped"]),
  completed: new Set(),
  error: new Set(["queued"]),
  stopped: new Set(["queued"]),
};

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsage(value: unknown): ResponseUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.provider !== "string" || typeof usage.model !== "string") return undefined;
  return {
    provider: usage.provider,
    model: usage.model,
    responseModel: typeof usage.responseModel === "string" ? usage.responseModel : undefined,
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    cacheReadTokens: finiteNumber(usage.cacheReadTokens),
    cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
    totalTokens: finiteNumber(usage.totalTokens),
    requestCount: typeof usage.requestCount === "number" && Number.isInteger(usage.requestCount) && usage.requestCount > 0 ? usage.requestCount : 1,
    cost: finiteNumber(usage.cost),
  };
}

function parseModelSettings(value: unknown): SubagentRunInfo["modelSettings"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const settings = value as Record<string, unknown>;
  if (typeof settings.provider !== "string" || typeof settings.baseUrl !== "string" || typeof settings.modelId !== "string"
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(settings.thinkingLevel))) return undefined;
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    modelId: settings.modelId,
    thinkingLevel: settings.thinkingLevel as NonNullable<SubagentRunInfo["modelSettings"]>["thinkingLevel"],
  };
}

function parseCommonRun(run: Record<string, unknown>): Omit<SubagentRunInfo, "status" | "attempt" | "queuedAt"> | undefined {
  const modelSettings = parseModelSettings(run.modelSettings);
  if (
    typeof run.id !== "string"
    || typeof run.toolCallId !== "string"
    || typeof run.role !== "string"
    || typeof run.task !== "string"
    || typeof run.cwd !== "string"
    || typeof run.sessionId !== "string"
    || typeof run.startedAt !== "string"
    || typeof run.updatedAt !== "string"
    || (run.modelSettings !== undefined && !modelSettings)
  ) return undefined;
  return {
    id: run.id,
    parentRunId: typeof run.parentRunId === "string" ? run.parentRunId : undefined,
    parentConversationId: typeof run.parentConversationId === "string" ? run.parentConversationId : undefined,
    toolCallId: run.toolCallId,
    role: run.role,
    task: run.task,
    cwd: run.cwd,
    sessionId: run.sessionId,
    modelSettings,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: typeof run.completedAt === "string" ? run.completedAt : undefined,
    result: typeof run.result === "string" ? run.result : undefined,
    usage: parseUsage(run.usage),
    error: typeof run.error === "string" ? run.error : undefined,
  };
}

function parseV2Run(value: unknown): SubagentRunInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as Record<string, unknown>;
  const common = parseCommonRun(run);
  if (
    !common
    || typeof run.status !== "string"
    || !validStatuses.has(run.status as SubagentRunInfo["status"])
    || typeof run.attempt !== "number"
    || !Number.isInteger(run.attempt)
    || run.attempt < 0
    || typeof run.queuedAt !== "string"
  ) return undefined;
  return {
    ...common,
    status: run.status as SubagentRunInfo["status"],
    attempt: run.attempt,
    queuedAt: run.queuedAt,
  };
}

function migrateV1Run(value: unknown): SubagentRunInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as Record<string, unknown>;
  const common = parseCommonRun(run);
  if (!common || typeof run.status !== "string" || !v1Statuses.has(run.status)) return undefined;
  return {
    ...common,
    status: run.status === "running" ? "queued" : run.status as SubagentRunInfo["status"],
    attempt: 1,
    queuedAt: common.startedAt,
    completedAt: run.status === "running" ? undefined : common.completedAt,
    error: run.status === "running" ? undefined : common.error,
  };
}

export class InvalidSubagentRunTransitionError extends Error {
  constructor(readonly runId: string, readonly from: SubagentRunInfo["status"], readonly to: SubagentRunInfo["status"]) {
    super(`Cannot transition subagent run ${runId} from ${from} to ${to}.`);
    this.name = "InvalidSubagentRunTransitionError";
  }
}

export class UnsupportedSubagentRunStoreVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported subagent run store version: ${String(version)}.`);
    this.name = "UnsupportedSubagentRunStoreVersionError";
  }
}

export class SubagentRunStore {
  private readonly indexPath: string;
  private readonly runs = new Map<string, SubagentRunInfo>();
  private lastTimestampMilliseconds = 0;

  constructor(readonly directory: string) {
    this.indexPath = path.join(directory, "index.json");
    this.load();
  }

  list(): SubagentRunInfo[] {
    return [...this.runs.values()].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id));
  }

  get(id: string): SubagentRunInfo | undefined {
    return this.runs.get(id);
  }

  create(input: CreateSubagentRun): SubagentRunInfo {
    const now = this.nextTimestamp();
    const run: SubagentRunInfo = {
      ...input,
      id: randomUUID(),
      status: "queued",
      attempt: 0,
      queuedAt: now,
      startedAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    try {
      this.persist();
    } catch (error) {
      this.runs.delete(run.id);
      throw error;
    }
    return run;
  }

  createOrGet(input: CreateSubagentRun): SubagentRunInfo {
    const existing = this.list().find((run) => (
      run.parentConversationId === input.parentConversationId
      && run.parentRunId === input.parentRunId
      && run.toolCallId === input.toolCallId
    ));
    return existing ?? this.create(input);
  }

  claimNext(predicate: (run: SubagentRunInfo) => boolean = () => true): SubagentRunInfo | undefined {
    const next = [...this.runs.values()]
      .filter((run) => run.status === "queued" && predicate(run))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))[0];
    return next ? this.transition(next.id, "running") : undefined;
  }

  pause(id: string): SubagentRunInfo | undefined {
    return this.transition(id, "paused");
  }

  resume(id: string): SubagentRunInfo | undefined {
    return this.transition(id, "queued");
  }

  retry(id: string): SubagentRunInfo | undefined {
    return this.transition(id, "queued");
  }

  stop(id: string, error?: string): SubagentRunInfo | undefined {
    return this.transition(id, "stopped", { error });
  }

  complete(id: string, completion: CompleteSubagentRun = {}): SubagentRunInfo | undefined {
    return this.transition(id, "completed", completion);
  }

  fail(id: string, error: string, usage?: ResponseUsage): SubagentRunInfo | undefined {
    return this.transition(id, "error", { error, usage });
  }

  update(id: string, patch: UpdateSubagentRun): SubagentRunInfo | undefined {
    const current = this.runs.get(id);
    if (!current) return undefined;
    if (patch.status && patch.status !== current.status) {
      const details: Partial<SubagentRunInfo> = { ...patch };
      delete details.status;
      delete details.attempt;
      delete details.queuedAt;
      delete details.updatedAt;
      return this.transition(id, patch.status, details);
    }
    const run = {
      ...current,
      ...patch,
      id: current.id,
      status: current.status,
      attempt: current.attempt,
      queuedAt: current.queuedAt,
      startedAt: current.startedAt,
      completedAt: current.completedAt,
      updatedAt: this.nextTimestamp(),
    };
    this.runs.set(id, run);
    try {
      this.persist();
    } catch (error) {
      this.runs.set(id, current);
      throw error;
    }
    return run;
  }

  findByToolCall(toolCallId: string, parentConversationId?: string): SubagentRunInfo | undefined {
    return this.list().find((run) => run.toolCallId === toolCallId && (!parentConversationId || run.parentConversationId === parentConversationId));
  }

  private transition(
    id: string,
    status: SubagentRunInfo["status"],
    details: Partial<Omit<SubagentRunInfo, "id" | "status" | "attempt" | "queuedAt" | "startedAt" | "updatedAt">> = {},
  ): SubagentRunInfo | undefined {
    const current = this.runs.get(id);
    if (!current) return undefined;
    if (current.status === status) return current;
    if (current.status !== status && !allowedTransitions[current.status].has(status)) {
      throw new InvalidSubagentRunTransitionError(id, current.status, status);
    }
    const now = this.nextTimestamp();
    const enteringQueue = status === "queued" && current.status !== "queued";
    const startingAttempt = status === "running" && current.status !== "running";
    const terminal = terminalStatuses.has(status);
    const run: SubagentRunInfo = {
      ...current,
      ...details,
      id: current.id,
      status,
      attempt: startingAttempt ? current.attempt + 1 : current.attempt,
      queuedAt: enteringQueue ? now : current.queuedAt,
      startedAt: current.startedAt,
      updatedAt: now,
      completedAt: terminal ? details.completedAt ?? now : undefined,
      result: terminal && status === "completed" ? details.result : status === "paused" ? current.result : undefined,
      error: terminal && status !== "completed" ? details.error : undefined,
      usage: terminal ? details.usage ?? current.usage : current.usage,
    };
    this.runs.set(id, run);
    try {
      this.persist();
    } catch (error) {
      this.runs.set(id, current);
      throw error;
    }
    return run;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as Partial<StoredIndexV1 | StoredIndexV2>;
      if (typeof parsed.version === "number" && parsed.version > 2) throw new UnsupportedSubagentRunStoreVersionError(parsed.version);
      if (!Array.isArray(parsed.runs) || (parsed.version !== 1 && parsed.version !== 2)) return;
      const migrated = parsed.version === 1;
      let recovered = false;
      for (const value of parsed.runs) {
        let run = migrated ? migrateV1Run(value) : parseV2Run(value);
        if (run) this.observeTimestamps(run);
        if (run?.status === "running") {
          run = {
            ...run,
            status: "queued",
            updatedAt: this.nextTimestamp(),
            completedAt: undefined,
            result: undefined,
            error: undefined,
          };
          recovered = true;
        }
        if (run) {
          this.runs.set(run.id, run);
        }
      }
      if (migrated || recovered) this.persist();
    } catch (error) {
      if (error instanceof UnsupportedSubagentRunStoreVersionError) throw error;
      // A missing or malformed index must not prevent the Agent runtime from starting.
    }
  }

  private nextTimestamp(): string {
    const milliseconds = Math.max(Date.now(), this.lastTimestampMilliseconds + 1);
    this.lastTimestampMilliseconds = milliseconds;
    return new Date(milliseconds).toISOString();
  }

  private observeTimestamps(run: SubagentRunInfo): void {
    for (const value of [run.queuedAt, run.startedAt, run.updatedAt, run.completedAt]) {
      if (!value) continue;
      const milliseconds = Date.parse(value);
      if (Number.isFinite(milliseconds)) this.lastTimestampMilliseconds = Math.max(this.lastTimestampMilliseconds, milliseconds);
    }
  }

  private persist(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 2, runs: this.list() } satisfies StoredIndexV2, null, 2));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.indexPath);
      this.syncDirectory();
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file was either renamed successfully or never created.
      }
      throw error;
    }
  }

  private syncDirectory(): void {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.directory, "r");
      fs.fsyncSync(descriptor);
    } catch {
      // Some platforms do not permit opening directory handles; the atomic rename still applies.
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
}
