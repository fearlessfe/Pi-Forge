import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PlanReviewArtifact, PlanReviewAnnotation, ResolvePlanReviewInput } from "../src/contracts.js";
import { planReviewBlocks } from "../src/plan-review.js";

type StoredPlanReviews = { version: 1; reviews: PlanReviewArtifact[] };
type PlanReviewRequest = Pick<PlanReviewArtifact, "cwd" | "conversationId" | "runId" | "toolCallId" | "title"> & { markdown: string };

const maxPlanMarkdownLength = 200_000;
const maxReviews = 200;

function contentHash(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function cloneReview(review: PlanReviewArtifact): PlanReviewArtifact {
  return { ...review, versions: review.versions.map((version) => ({ ...version, annotations: version.annotations.map((annotation) => ({ ...annotation })) })) };
}

function parseReview(value: unknown): PlanReviewArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const review = value as Record<string, unknown>;
  if (
    typeof review.id !== "string"
    || typeof review.cwd !== "string"
    || !path.isAbsolute(review.cwd)
    || typeof review.conversationId !== "string"
    || typeof review.runId !== "string"
    || typeof review.toolCallId !== "string"
    || typeof review.title !== "string"
    || (review.status !== "pending" && review.status !== "approved" && review.status !== "changes_requested")
    || typeof review.activeVersionId !== "string"
    || typeof review.createdAt !== "string"
    || typeof review.updatedAt !== "string"
    || !Array.isArray(review.versions)
  ) return undefined;
  const versions = review.versions.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const version = entry as Record<string, unknown>;
    if (
      typeof version.id !== "string"
      || typeof version.markdown !== "string"
      || version.markdown.length > maxPlanMarkdownLength
      || typeof version.contentHash !== "string"
      || typeof version.createdAt !== "string"
      || !Array.isArray(version.annotations)
    ) return [];
    const annotations = version.annotations.flatMap((annotation): PlanReviewAnnotation[] => {
      if (!annotation || typeof annotation !== "object") return [];
      const item = annotation as Record<string, unknown>;
      return typeof item.id === "string" && typeof item.anchorId === "string" && typeof item.quote === "string" && typeof item.comment === "string" && typeof item.createdAt === "string"
        ? [{ id: item.id, anchorId: item.anchorId, quote: item.quote, comment: item.comment, createdAt: item.createdAt }]
        : [];
    });
    const decision = version.decision === "approved" || version.decision === "changes_requested" ? version.decision as "approved" | "changes_requested" : undefined;
    return [{ id: version.id, number: index + 1, markdown: version.markdown, contentHash: version.contentHash, createdAt: version.createdAt, annotations, decision, decidedAt: typeof version.decidedAt === "string" ? version.decidedAt : undefined }];
  });
  if (versions.length === 0 || !versions.some((version) => version.id === review.activeVersionId)) return undefined;
  return { id: review.id, cwd: path.resolve(review.cwd), conversationId: review.conversationId, runId: review.runId, toolCallId: review.toolCallId, title: review.title, status: review.status, activeVersionId: review.activeVersionId, createdAt: review.createdAt, updatedAt: review.updatedAt, versions };
}

export class PlanReviewStore {
  private readonly filePath: string;
  private reviews: PlanReviewArtifact[];

  constructor(directory: string) {
    this.filePath = path.join(directory, "plan-reviews.json");
    this.reviews = this.read();
  }

  list(conversationId?: string): PlanReviewArtifact[] {
    return this.reviews.filter((review) => !conversationId || review.conversationId === conversationId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneReview);
  }

  request(input: PlanReviewRequest): PlanReviewArtifact {
    const title = input.title.trim();
    const markdown = input.markdown.trim();
    if (!title || title.length > 200) throw new Error("计划标题无效。");
    if (!markdown || markdown.length > maxPlanMarkdownLength) throw new Error("计划 Markdown 无效或过长。");
    const hash = contentHash(markdown);
    const existing = this.list(input.conversationId).find((review) => review.title === title);
    if (existing) {
      const active = existing.versions.find((version) => version.id === existing.activeVersionId);
      if (active?.contentHash === hash) return existing;
      const now = new Date().toISOString();
      const version = { id: randomUUID(), number: existing.versions.length + 1, markdown, contentHash: hash, createdAt: now, annotations: [] };
      const updated: PlanReviewArtifact = { ...existing, runId: input.runId, toolCallId: input.toolCallId, status: "pending", activeVersionId: version.id, updatedAt: now, versions: [...existing.versions, version] };
      this.replace(updated);
      return cloneReview(updated);
    }
    const now = new Date().toISOString();
    const version = { id: randomUUID(), number: 1, markdown, contentHash: hash, createdAt: now, annotations: [] };
    const review: PlanReviewArtifact = { id: randomUUID(), cwd: path.resolve(input.cwd), conversationId: input.conversationId, runId: input.runId, toolCallId: input.toolCallId, title, status: "pending", activeVersionId: version.id, createdAt: now, updatedAt: now, versions: [version] };
    this.reviews.push(review);
    this.persist();
    return cloneReview(review);
  }

  resolve(input: ResolvePlanReviewInput): PlanReviewArtifact {
    const review = this.reviews.find((entry) => entry.id === input.reviewId);
    if (!review) throw new Error("找不到待审阅计划。");
    if (review.status !== "pending" || review.activeVersionId !== input.versionId) throw new Error("该计划版本已处理或不是当前版本。");
    const version = review.versions.find((entry) => entry.id === input.versionId);
    if (!version) throw new Error("找不到计划版本。");
    const blocks = new Map(planReviewBlocks(version.markdown).map((block) => [block.id, block]));
    const now = new Date().toISOString();
    const annotations = input.annotations.map((annotation): PlanReviewAnnotation => {
      const block = blocks.get(annotation.anchorId);
      const comment = annotation.comment.trim();
      if (!block || !comment || comment.length > 4_000) throw new Error("计划批注无效。");
      return { id: randomUUID(), anchorId: block.id, quote: block.quote, comment, createdAt: now };
    });
    if (input.decision === "changes_requested" && annotations.length === 0) throw new Error("要求修改时至少需要一条批注。");
    const versions = review.versions.map((entry) => entry.id === version.id ? { ...entry, annotations, decision: input.decision, decidedAt: now } : entry);
    const updated: PlanReviewArtifact = { ...review, status: input.decision, updatedAt: now, versions };
    this.replace(updated);
    return cloneReview(updated);
  }

  private replace(review: PlanReviewArtifact): void {
    this.reviews = this.reviews.map((entry) => entry.id === review.id ? review : entry);
    this.persist();
  }

  private read(): PlanReviewArtifact[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoredPlanReviews>;
      if (value.version !== 1 || !Array.isArray(value.reviews)) return [];
      return value.reviews.map(parseReview).filter((review): review is PlanReviewArtifact => Boolean(review));
    } catch {
      return [];
    }
  }

  private persist(): void {
    this.reviews = this.reviews.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, maxReviews);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, reviews: this.reviews } satisfies StoredPlanReviews, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
