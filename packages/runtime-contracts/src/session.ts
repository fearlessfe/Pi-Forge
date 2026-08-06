export type PlanReviewDecision = "approved" | "changes_requested";

export type PlanReviewAnnotation = {
  id: string;
  anchorId: string;
  quote: string;
  comment: string;
  createdAt: string;
};

export type PlanReviewVersion = {
  id: string;
  number: number;
  markdown: string;
  contentHash: string;
  createdAt: string;
  annotations: PlanReviewAnnotation[];
  decision?: PlanReviewDecision;
  decidedAt?: string;
};

export type PlanReviewArtifact = {
  id: string;
  cwd: string;
  conversationId: string;
  runId: string;
  toolCallId: string;
  title: string;
  status: "pending" | PlanReviewDecision;
  activeVersionId: string;
  createdAt: string;
  updatedAt: string;
  versions: PlanReviewVersion[];
};

export type PlanReviewDraft = {
  runId: string;
  toolCallId: string;
  title: string;
  markdown: string;
};

export type ResolvePlanReviewInput = {
  reviewId: string;
  versionId: string;
  decision: PlanReviewDecision;
  annotations: Array<Pick<PlanReviewAnnotation, "anchorId" | "quote" | "comment">>;
};

export type QuestionOption = { label: string; description?: string };

export type ContextUsageInfo = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type QueuedMessages = { steering: string[]; followUp: string[] };

export type TaskFileChange = {
  id: string;
  runId: string;
  callId: string;
  path: string;
  relativePath: string;
  kind: "created" | "modified";
  patch: string;
  beforeHash?: string;
  afterHash: string;
  status: "pending" | "accepted" | "reverted" | "conflict";
  revertible: boolean;
  error?: string;
};

export type ResponseUsage = {
  provider: string;
  model: string;
  responseModel?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requestCount: number;
  cost: number;
};

export type SubagentRunInfo = {
  id: string;
  parentRunId?: string;
  parentConversationId?: string;
  toolCallId: string;
  role: string;
  task: string;
  cwd: string;
  sessionId: string;
  status: "running" | "completed" | "error" | "stopped";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  usage?: ResponseUsage;
  error?: string;
};

export type SubagentModelSettings = {
  provider: string;
  baseUrl: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

export type EnqueueSubagentInput = {
  parentRunId?: string;
  parentConversationId?: string;
  toolCallId: string;
  role: string;
  task: string;
  cwd: string;
  modelSettings?: SubagentModelSettings;
};

/** Capability-gated background scheduler record; it does not widen the stable v1 legacy type. */
export type BackgroundSubagentRunInfo = Omit<SubagentRunInfo, "status"> & {
  modelSettings?: SubagentModelSettings;
  status: "queued" | "running" | "paused" | "completed" | "error" | "stopped";
  attempt: number;
  queuedAt: string;
  result?: string;
};

export type ToolActivityDetails = {
  /** Legacy synchronous Subagent record retained for Runtime v1 compatibility. */
  subagent?: SubagentRunInfo;
  /** Present only when the optional `subagent.background` capability is negotiated. */
  backgroundSubagent?: BackgroundSubagentRunInfo;
  [key: string]: unknown;
};

export type ConversationActivity =
  | { id: string; type: "message"; text: string }
  | { id: string; type: "thinking"; text: string }
  | { id: string; type: "tool"; name: string; args: unknown; output: string; status: "running" | "success" | "error"; details?: ToolActivityDetails }
  | { id: string; type: "question"; question: string; options: QuestionOption[]; answer?: string; status: "pending" | "answered" }
  | { id: string; type: "plan_review"; title: string; markdown: string; status: "streaming" | PlanReviewArtifact["status"]; review?: PlanReviewArtifact };

export type TurnAttachment = {
  kind: "image" | "file";
  name: string;
  dataUrl?: string;
  id?: string;
  mimeType?: string;
  size?: number;
  access?: "inline" | "tool";
};

export type PromptImage = { name: string; mimeType: string; data: string };
export type PromptFileAttachment = { name: string; mimeType?: string; content: string };

export type SendPromptInput = {
  prompt: string;
  cwd?: string;
  conversationId?: string;
  images?: PromptImage[];
  attachments?: PromptFileAttachment[];
};

export type RuntimeRecoveryInfo = {
  id: string;
  runId?: string;
  input: SendPromptInput;
  status: "starting" | "running" | "interrupted";
  attempts: number;
  startedAt: string;
  updatedAt: string;
  message?: string;
};

export type ConversationHistoryItem = {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  archived: boolean;
  searchText: string;
  parentConversationId?: string;
  project?: { id: string; name: string; path: string };
};

export type ConversationListQuery = {
  cursor?: string;
  limit?: number;
  query?: string;
  archived?: boolean;
  projectId?: string;
};

export type ConversationHistoryPage = {
  items: ConversationHistoryItem[];
  nextCursor?: string;
  total: number;
};

export type ConversationHistoryTurn = {
  id: string;
  question: string;
  answer: string;
  activities: ConversationActivity[];
  attachments?: TurnAttachment[];
  fileChanges?: TaskFileChange[];
  usage?: ResponseUsage;
};

export type ConversationHistoryDetail = ConversationHistoryItem & {
  turns: ConversationHistoryTurn[];
  contextUsage?: ContextUsageInfo;
};

export type ConversationExport = {
  filename: string;
  mimeType: "text/markdown" | "application/json";
  content: string;
};

export type ConversationUpdatedEvent =
  | {
      type: "conversation.updated";
      kind: "upsert";
      reason: "run-completed" | "run-error" | "run-stopped" | "renamed" | "tags-changed" | "archive-changed" | "forked";
      conversation: ConversationHistoryItem;
    }
  | { type: "conversation.updated"; kind: "delete"; reason: "deleted"; conversationId: string };
