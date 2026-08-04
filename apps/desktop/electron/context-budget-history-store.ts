import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContextBudgetSnapshot } from "../src/contracts.js";

type StoredHistory = { version: 1; snapshots: ContextBudgetSnapshot[] };
type SnapshotInput = Omit<ContextBudgetSnapshot, "id" | "createdAt" | "deltaTokens" | "estimatedSharePercent">;

const maxSnapshots = 500;
const maxSnapshotsPerWorkspace = 100;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseSnapshot(value: unknown): ContextBudgetSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as Record<string, unknown>;
  const estimatedResourceTokens = finiteNonNegative(snapshot.estimatedResourceTokens);
  const estimateBasis = snapshot.estimateBasis === "baseline" ? "baseline" : "potential";
  const actualInputTokens = finiteNonNegative(snapshot.actualInputTokens);
  const actualContextTokens = snapshot.actualContextTokens === null ? null : finiteNonNegative(snapshot.actualContextTokens);
  const deltaTokens = typeof snapshot.deltaTokens === "number" && Number.isFinite(snapshot.deltaTokens) ? snapshot.deltaTokens : undefined;
  const estimatedSharePercent = snapshot.estimatedSharePercent === null ? null : finiteNonNegative(snapshot.estimatedSharePercent);
  if (
    typeof snapshot.id !== "string"
    || typeof snapshot.cwd !== "string"
    || !path.isAbsolute(snapshot.cwd)
    || typeof snapshot.conversationId !== "string"
    || typeof snapshot.runId !== "string"
    || typeof snapshot.createdAt !== "string"
    || typeof snapshot.provider !== "string"
    || typeof snapshot.model !== "string"
    || typeof snapshot.estimatorId !== "string"
    || estimatedResourceTokens === undefined
    || actualInputTokens === undefined
    || actualContextTokens === undefined
    || deltaTokens === undefined
    || estimatedSharePercent === undefined
  ) return undefined;
  return {
    id: snapshot.id,
    cwd: path.resolve(snapshot.cwd),
    conversationId: snapshot.conversationId,
    runId: snapshot.runId,
    createdAt: snapshot.createdAt,
    provider: snapshot.provider,
    model: snapshot.model,
    estimatorId: snapshot.estimatorId as ContextBudgetSnapshot["estimatorId"],
    estimateBasis,
    estimatedResourceTokens,
    actualInputTokens,
    actualContextTokens,
    deltaTokens,
    estimatedSharePercent,
  };
}

export class ContextBudgetHistoryStore {
  private readonly filePath: string;
  private snapshots: ContextBudgetSnapshot[];

  constructor(directory: string) {
    this.filePath = path.join(directory, "context-budget-history.json");
    this.snapshots = this.read();
  }

  list(cwd: string): ContextBudgetSnapshot[] {
    const resolved = path.resolve(cwd);
    return this.snapshots.filter((snapshot) => snapshot.cwd === resolved)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, maxSnapshotsPerWorkspace)
      .map((snapshot) => ({ ...snapshot }));
  }

  record(input: SnapshotInput): ContextBudgetSnapshot {
    const actualBasis = input.actualContextTokens ?? input.actualInputTokens;
    const snapshot: ContextBudgetSnapshot = {
      ...input,
      cwd: path.resolve(input.cwd),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      deltaTokens: actualBasis - input.estimatedResourceTokens,
      estimatedSharePercent: actualBasis > 0 ? (input.estimatedResourceTokens / actualBasis) * 100 : null,
    };
    this.snapshots.push(snapshot);
    const workspaceSnapshots = new Map<string, number>();
    this.snapshots = this.snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .filter((entry) => {
        const count = workspaceSnapshots.get(entry.cwd) ?? 0;
        if (count >= maxSnapshotsPerWorkspace) return false;
        workspaceSnapshots.set(entry.cwd, count + 1);
        return true;
      })
      .slice(0, maxSnapshots);
    this.persist();
    return { ...snapshot };
  }

  private read(): ContextBudgetSnapshot[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredHistory>;
      if (value.version !== 1 || !Array.isArray(value.snapshots)) return [];
      return value.snapshots.map(parseSnapshot).filter((entry): entry is ContextBudgetSnapshot => Boolean(entry));
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, snapshots: this.snapshots } satisfies StoredHistory, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
