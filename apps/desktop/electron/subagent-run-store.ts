import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ResponseUsage, SubagentRunInfo } from "../src/contracts.js";

type StoredIndex = {
  version: 1;
  runs: SubagentRunInfo[];
};

type CreateSubagentRun = Omit<SubagentRunInfo, "id" | "status" | "startedAt" | "updatedAt">;

const validStatuses = new Set<SubagentRunInfo["status"]>(["running", "completed", "error", "stopped"]);

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

function parseRun(value: unknown): SubagentRunInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as Record<string, unknown>;
  if (
    typeof run.id !== "string"
    || typeof run.toolCallId !== "string"
    || typeof run.role !== "string"
    || typeof run.task !== "string"
    || typeof run.cwd !== "string"
    || typeof run.sessionId !== "string"
    || typeof run.status !== "string"
    || !validStatuses.has(run.status as SubagentRunInfo["status"])
    || typeof run.startedAt !== "string"
    || typeof run.updatedAt !== "string"
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
    status: run.status as SubagentRunInfo["status"],
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: typeof run.completedAt === "string" ? run.completedAt : undefined,
    usage: parseUsage(run.usage),
    error: typeof run.error === "string" ? run.error : undefined,
  };
}

export class SubagentRunStore {
  private readonly indexPath: string;
  private readonly runs = new Map<string, SubagentRunInfo>();

  constructor(readonly directory: string) {
    this.indexPath = path.join(directory, "index.json");
    this.load();
  }

  list(): SubagentRunInfo[] {
    return [...this.runs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  create(input: CreateSubagentRun): SubagentRunInfo {
    const now = new Date().toISOString();
    const run: SubagentRunInfo = { ...input, id: randomUUID(), status: "running", startedAt: now, updatedAt: now };
    this.runs.set(run.id, run);
    this.persist();
    return run;
  }

  update(id: string, patch: Partial<Omit<SubagentRunInfo, "id" | "startedAt">>): SubagentRunInfo | undefined {
    const current = this.runs.get(id);
    if (!current) return undefined;
    const run = { ...current, ...patch, id: current.id, startedAt: current.startedAt, updatedAt: new Date().toISOString() };
    this.runs.set(id, run);
    this.persist();
    return run;
  }

  findByToolCall(toolCallId: string, parentConversationId?: string): SubagentRunInfo | undefined {
    return this.list().find((run) => run.toolCallId === toolCallId && (!parentConversationId || run.parentConversationId === parentConversationId));
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as Partial<StoredIndex>;
      if (parsed.version !== 1 || !Array.isArray(parsed.runs)) return;
      let recovered = false;
      for (const value of parsed.runs) {
        let run = parseRun(value);
        if (run?.status === "running") {
          const now = new Date().toISOString();
          run = { ...run, status: "stopped", updatedAt: now, completedAt: now, error: "Runtime exited before the subagent completed." };
          recovered = true;
        }
        if (run) this.runs.set(run.id, run);
      }
      if (recovered) this.persist();
    } catch {
      // A missing or malformed index must not prevent the Agent runtime from starting.
    }
  }

  private persist(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, runs: this.list() } satisfies StoredIndex, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.indexPath);
  }
}
