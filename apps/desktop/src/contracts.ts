export const compatibleProviderIds = [
  "openai-compatible",
  "openai-responses-compatible",
  "anthropic-compatible",
  "google-compatible",
] as const;

export type ProviderId = string;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PermissionMode = "balanced" | "strict";

export type PermissionSettings = {
  mode: PermissionMode;
};

export type PermissionRuntime = PermissionSettings & {
  sandbox: "available" | "unavailable";
  platform: string;
};

export type ModelSettings = {
  provider: ProviderId;
  baseUrl: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  hasApiKey: boolean;
  configuredProviders: ProviderId[];
  credentials: Array<{ providerId: ProviderId; type: "api_key" | "oauth" }>;
};

export type SaveModelSettings = Omit<ModelSettings, "hasApiKey" | "configuredProviders" | "credentials"> & {
  apiKey?: string;
};

export type ModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Wire protocol used to call this model, e.g. openai-responses. */
  protocol?: string;
  contextWindow: number;
  /** Maximum generated tokens per response, when published by the provider. */
  maxOutputTokens?: number;
  /** USD per one million tokens. */
  pricing?: ModelPricing;
  metadataSource?: "official" | "endpoint";
  metadataSourceUrl?: string;
  metadataUpdatedAt?: string;
  isMetadataOverridden?: boolean;
};

export type ModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelMetadataOverride = {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
};

export type ProviderCatalogEntry = {
  id: ProviderId;
  name: string;
  baseUrl: string;
  kind: "builtin" | "compatible";
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  oauthName?: string;
  models: ModelCatalogEntry[];
};

export type AuthPrompt = {
  requestId: string;
  promptType: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
};

export type AuthEvent =
  | { type: "auth.started"; loginId: string; providerId: ProviderId }
  | { type: "auth.url"; loginId: string; providerId: ProviderId; url: string; instructions?: string }
  | { type: "auth.device-code"; loginId: string; providerId: ProviderId; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "auth.progress"; loginId: string; providerId: ProviderId; message: string }
  | { type: "auth.prompt"; loginId: string; providerId: ProviderId; prompt: AuthPrompt }
  | { type: "auth.prompt-cancelled"; loginId: string; providerId: ProviderId; requestId: string }
  | { type: "auth.completed"; loginId: string; providerId: ProviderId }
  | { type: "auth.cancelled"; loginId: string; providerId: ProviderId }
  | { type: "auth.error"; loginId: string; providerId: ProviderId; message: string };

export type QuestionOption = {
  label: string;
  description?: string;
};

export type ContextUsageInfo = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
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
  /** Number of internal model requests made while producing this answer. */
  requestCount: number;
  /** Aggregate cost of all internal model requests for this answer. */
  cost: number;
};

export type ConversationActivity =
  | { id: string; type: "message"; text: string }
  | { id: string; type: "thinking"; text: string }
  | { id: string; type: "tool"; name: string; args: unknown; output: string; status: "running" | "success" | "error" }
  | { id: string; type: "question"; question: string; options: QuestionOption[]; answer?: string; status: "pending" | "answered" };

export type PiAgentEventType =
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "queue_update"
  | "compaction_start"
  | "compaction_end"
  | "entry_appended"
  | "session_info_changed"
  | "thinking_level_changed"
  | "auto_retry_start"
  | "auto_retry_end"
  | "summarization_retry_scheduled"
  | "summarization_retry_attempt_start"
  | "summarization_retry_finished";

export type AgentTraceEvent = {
  sequence: number;
  timestamp: number;
  eventType: PiAgentEventType;
  payload: unknown;
};

export type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "message.delta"; runId: string; text: string }
  | { type: "thinking.delta"; runId: string; text: string }
  | { type: "tool.started"; runId: string; callId: string; name: string; args: unknown }
  | { type: "tool.updated"; runId: string; callId: string; name: string; output: string }
  | { type: "tool.completed"; runId: string; callId: string; name: string; output: string; isError: boolean }
  | { type: "question.requested"; runId: string; callId: string; question: string; options: QuestionOption[] }
  | { type: "response.usage"; runId: string; usage: ResponseUsage }
  | { type: "context.updated"; runId: string; usage: ContextUsageInfo }
  | { type: "agent.event"; runId: string; event: AgentTraceEvent }
  | { type: "run.completed"; runId: string }
  | { type: "run.stopped"; runId: string }
  | { type: "run.error"; runId: string; message: string };

export type SendPromptInput = {
  prompt: string;
  cwd?: string;
  conversationId?: string;
};

export type ConversationHistoryItem = {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  project?: { id: string; name: string; path: string };
};

export type ConversationHistoryTurn = {
  id: string;
  question: string;
  answer: string;
  activities: ConversationActivity[];
  usage?: ResponseUsage;
};

export type ConversationHistoryDetail = ConversationHistoryItem & {
  turns: ConversationHistoryTurn[];
  contextUsage?: ContextUsageInfo;
};

export type PluginResourceType = "extensions" | "skills" | "prompts" | "themes";

export type PluginPackage = {
  name: string;
  version: string;
  description: string;
  publisher: string;
  license?: string;
  updatedAt?: string;
  npmUrl?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  weeklyDownloads?: number;
  monthlyDownloads?: number;
  score?: number;
  insecure: boolean;
  resources: PluginResourceType[];
  compatibility: "desktop" | "review" | "unknown";
};

export type PluginSearchResult = {
  packages: PluginPackage[];
  total: number;
  offset: number;
};

export type InstalledPlugin = {
  source: string;
  name: string;
  version?: string;
  installed: boolean;
};

export type PluginProgressEvent = {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
};

export type PluginMutationResult = {
  installed: InstalledPlugin[];
  reloaded: boolean;
  runtime: PluginRuntimeStatus;
};

export type SubagentProvider =
  | { kind: "builtin" }
  | { kind: "plugin"; source: string; toolName: string };

export type PackageCapabilityProvider =
  | { kind: "none" }
  | { kind: "plugin"; source: string };

export type CapabilitySettings = {
  subagent: SubagentProvider;
  memory: PackageCapabilityProvider;
  learning: PackageCapabilityProvider;
  subagentHistory: SubagentProvider[];
  memoryHistory: PackageCapabilityProvider[];
  learningHistory: PackageCapabilityProvider[];
};

export type RuntimeTool = {
  name: string;
  description: string;
  active: boolean;
  source: string;
  sourceKind: "builtin" | "desktop" | "package" | "project" | "other";
};

export type PluginRuntimeStatus = {
  hasSession: boolean;
  configuredSubagent: SubagentProvider;
  effectiveSubagent: SubagentProvider | { kind: "pending" };
  configuredMemory: PackageCapabilityProvider;
  effectiveMemory: PackageCapabilityProvider | { kind: "pending" };
  configuredLearning: PackageCapabilityProvider;
  effectiveLearning: PackageCapabilityProvider | { kind: "pending" };
  subagentHistory: SubagentProvider[];
  memoryHistory: PackageCapabilityProvider[];
  learningHistory: PackageCapabilityProvider[];
  fallbackReason?: string;
  tools: RuntimeTool[];
};

export type PiDesktopApi = {
  settings: {
    get(): Promise<ModelSettings>;
    catalog(): Promise<ProviderCatalogEntry[]>;
    refreshMetadata(): Promise<ProviderCatalogEntry[]>;
    saveMetadata(providerId: ProviderId, modelId: string, metadata: ModelMetadataOverride): Promise<ProviderCatalogEntry[]>;
    resetMetadata(providerId: ProviderId, modelId: string): Promise<ProviderCatalogEntry[]>;
    discoverModels(settings: SaveModelSettings): Promise<ModelCatalogEntry[]>;
    save(settings: SaveModelSettings): Promise<ModelSettings>;
    test(settings: SaveModelSettings): Promise<{ ok: true; response: string }>;
  };
  permissions: {
    get(): Promise<PermissionRuntime>;
    save(settings: PermissionSettings): Promise<PermissionRuntime>;
  };
  auth: {
    login(providerId: ProviderId): Promise<{ loginId: string }>;
    answer(requestId: string, value: string): Promise<void>;
    cancel(loginId: string): Promise<void>;
    logout(providerId: ProviderId): Promise<void>;
    onEvent(listener: (event: AuthEvent) => void): () => void;
  };
  workspace: {
    choose(): Promise<{ name: string; path: string } | null>;
  };
  plugins: {
    search(query: string, offset?: number): Promise<PluginSearchResult>;
    details(name: string, version?: string): Promise<PluginPackage>;
    list(): Promise<InstalledPlugin[]>;
    install(name: string, version: string): Promise<PluginMutationResult>;
    remove(source: string): Promise<PluginMutationResult>;
    reload(): Promise<{ reloaded: boolean; runtime: PluginRuntimeStatus }>;
    runtime(): Promise<PluginRuntimeStatus>;
    setSubagentProvider(provider: SubagentProvider): Promise<PluginRuntimeStatus>;
    setPackageCapability(slot: "memory" | "learning", provider: PackageCapabilityProvider): Promise<PluginRuntimeStatus>;
    onEvent(listener: (event: PluginProgressEvent) => void): () => void;
  };
  agent: {
    send(input: SendPromptInput): Promise<{ runId: string }>;
    listConversations(): Promise<ConversationHistoryItem[]>;
    loadConversation(conversationId: string): Promise<ConversationHistoryDetail>;
    renameConversation(conversationId: string, title: string): Promise<void>;
    deleteConversation(conversationId: string): Promise<void>;
    abort(): Promise<void>;
    reset(): Promise<void>;
    answerQuestion(callId: string, answer: string): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
};
