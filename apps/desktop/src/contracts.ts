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

export type SystemPromptSettings = {
  content: string;
};

export type ResourceSettings = {
  workspaceContextEnabled: boolean;
  disabledSkills: string[];
};

export type WorkspaceTrustStatus = {
  path: string;
  trusted: boolean;
  hasProjectResources: boolean;
  resourcePaths: string[];
};

export type ResourceDiagnosticInfo = {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
};

export type SkillResourceInfo = {
  name: string;
  description: string;
  filePath: string;
  scope: "user" | "project" | "temporary";
  source: string;
  sourceKind: "package" | "local";
  enabled: boolean;
  modelInvocable: boolean;
};

export type CommandInfo = {
  name: string;
  description: string;
  source: "extension" | "prompt" | "skill" | "desktop";
  sourceLabel: string;
  argumentHint?: string;
};

export type ResourceInventory = {
  cwd: string;
  settings: ResourceSettings;
  trust: WorkspaceTrustStatus;
  skills: SkillResourceInfo[];
  diagnostics: ResourceDiagnosticInfo[];
  commands: CommandInfo[];
};

export type McpServerScope = "user" | "project";

export type McpStdioTransport = {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
};

export type McpHttpTransport = {
  type: "streamable-http";
  url: string;
  headers: Record<string, string>;
};

export type McpServerConfig = {
  key: string;
  id: string;
  name: string;
  scope: McpServerScope;
  enabled: boolean;
  timeoutMs: number;
  transport: McpStdioTransport | McpHttpTransport;
  hasCredentials: boolean;
  projectPath?: string;
};

export type SaveMcpServerInput = Omit<McpServerConfig, "key" | "hasCredentials" | "projectPath"> & {
  previousKey?: string;
  projectPath?: string;
  secretEnvironment?: Record<string, string>;
  secretHeaders?: Record<string, string>;
  clearCredentials?: boolean;
};

export type McpToolInfo = {
  name: string;
  remoteName: string;
  description: string;
};

export type McpServerRuntime = {
  key: string;
  state: "disabled" | "disconnected" | "connecting" | "connected" | "error";
  serverName?: string;
  serverVersion?: string;
  error?: string;
  tools: McpToolInfo[];
  updatedAt: string;
};

export type McpLogEntry = {
  id: string;
  serverKey: string;
  timestamp: string;
  level: "info" | "error";
  message: string;
};

export type McpOverview = {
  servers: McpServerConfig[];
  runtimes: McpServerRuntime[];
  logs: McpLogEntry[];
};

export type TerminalSessionInfo = {
  id: string;
  cwd: string;
  shell: string;
  title: string;
  status: "running" | "exited";
  cols: number;
  rows: number;
  exitCode?: number;
};

export type TerminalEvent =
  | { type: "terminal.data"; id: string; data: string }
  | { type: "terminal.exit"; id: string; exitCode: number; signal?: number };

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

export type QueuedMessages = {
  steering: string[];
  followUp: string[];
};

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
  /** Number of internal model requests made while producing this answer. */
  requestCount: number;
  /** Aggregate cost of all internal model requests for this answer. */
  cost: number;
};

export type TraceCaptureContent = "none" | "metadata" | "full";

export type OtlpTraceExporterSettings = {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  hasHeaders: boolean;
};

export type SaveOtlpTraceExporterSettings = Omit<OtlpTraceExporterSettings, "id" | "hasHeaders"> & {
  id?: string;
  /** Omit to preserve existing encrypted headers for this exporter. */
  headers?: Record<string, string>;
};

export type ObservabilitySettings = {
  enabled: boolean;
  serviceName: string;
  captureContent: TraceCaptureContent;
  localFileEnabled: boolean;
  exporters: OtlpTraceExporterSettings[];
};

export type SaveObservabilitySettings = Omit<ObservabilitySettings, "exporters"> & {
  exporters: SaveOtlpTraceExporterSettings[];
};

export type TraceRuntimeStatus = {
  enabled: boolean;
  localTracePath?: string;
  queuedSpanCount: number;
  lastExportAt?: string;
  lastError?: string;
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

export type ToolActivityDetails = {
  subagent?: SubagentRunInfo;
  [key: string]: unknown;
};

export type ConversationActivity =
  | { id: string; type: "message"; text: string }
  | { id: string; type: "thinking"; text: string }
  | { id: string; type: "tool"; name: string; args: unknown; output: string; status: "running" | "success" | "error"; details?: ToolActivityDetails }
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
  | { type: "run.started"; runId: string; conversationId: string; provider: string; model: string; cwd: string }
  | { type: "message.delta"; runId: string; text: string }
  | { type: "thinking.delta"; runId: string; text: string }
  | { type: "tool.started"; runId: string; callId: string; name: string; args: unknown }
  | { type: "tool.updated"; runId: string; callId: string; name: string; output: string; details?: ToolActivityDetails }
  | { type: "tool.completed"; runId: string; callId: string; name: string; output: string; isError: boolean; details?: ToolActivityDetails }
  | { type: "question.requested"; runId: string; callId: string; question: string; options: QuestionOption[] }
  | { type: "response.usage"; runId: string; usage: ResponseUsage }
  | { type: "context.updated"; runId: string; usage: ContextUsageInfo }
  | { type: "queue.updated"; runId: string; queue: QueuedMessages }
  | { type: "changes.updated"; runId: string; changes: TaskFileChange[] }
  | { type: "agent.event"; runId: string; event: AgentTraceEvent }
  | { type: "run.completed"; runId: string }
  | { type: "run.stopped"; runId: string }
  | { type: "run.error"; runId: string; message: string };

export type SendPromptInput = {
  prompt: string;
  cwd?: string;
  conversationId?: string;
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

export type ConversationHistoryTurn = {
  id: string;
  question: string;
  answer: string;
  activities: ConversationActivity[];
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

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  annotating: boolean;
  error?: string;
};

export type BrowserAnnotationElement = {
  index: number;
  tag: string;
  selector: string;
  id?: string;
  classes: string[];
  text?: string;
  comment?: string;
  rect: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string>;
  styles: Record<string, string>;
  accessibility: {
    role?: string;
    name?: string;
    focusable: boolean;
    disabled: boolean;
  };
};

export type BrowserAnnotationResult = {
  success: boolean;
  cancelled?: boolean;
  reason?: string;
  url: string;
  title: string;
  prompt?: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  elements: BrowserAnnotationElement[];
  screenshotPath?: string;
};

export type BrowserAnnotationCapture = {
  result: BrowserAnnotationResult;
  markdown: string;
};

export type BrowserEvent = {
  type: "state";
  state: BrowserState;
};

export type PluginResourceType = "extensions" | "skills" | "prompts" | "themes";
export type PluginRiskTier = "low" | "medium" | "high" | "blocked";
export type PluginManifest = Partial<Record<PluginResourceType, string[]>>;

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
  usage?: string;
  weeklyDownloads?: number;
  monthlyDownloads?: number;
  score?: number;
  insecure: boolean;
  resources: PluginResourceType[];
  manifest: PluginManifest;
  integrity?: string;
  shasum?: string;
  provenance: "npm-registry";
  riskTier: PluginRiskTier;
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
  enabled: boolean;
  projectEnabled?: boolean;
  publisher?: string;
  integrity?: string;
  provenance?: "npm-registry" | "legacy";
  riskTier: PluginRiskTier;
  resources: PluginResourceType[];
  installedAt?: string;
  verification: "verified" | "legacy" | "missing" | "tampered";
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
  systemPrompt: {
    get(): Promise<SystemPromptSettings>;
    save(settings: SystemPromptSettings): Promise<SystemPromptSettings>;
  };
  observability: {
    get(): Promise<ObservabilitySettings>;
    save(settings: SaveObservabilitySettings): Promise<ObservabilitySettings>;
    status(): Promise<TraceRuntimeStatus>;
    flush(): Promise<TraceRuntimeStatus>;
  };
  auth: {
    login(providerId: ProviderId): Promise<{ loginId: string }>;
    answer(requestId: string, value: string): Promise<void>;
    cancel(loginId: string): Promise<void>;
    logout(providerId: ProviderId): Promise<void>;
    onEvent(listener: (event: AuthEvent) => void): () => void;
  };
  workspace: {
    choose(): Promise<({ name: string; path: string } & WorkspaceTrustStatus) | null>;
    trustStatus(path: string): Promise<WorkspaceTrustStatus>;
    setTrusted(path: string, trusted: boolean): Promise<WorkspaceTrustStatus>;
  };
  resources: {
    getSettings(): Promise<ResourceSettings>;
    saveSettings(settings: ResourceSettings): Promise<ResourceSettings>;
    inventory(cwd?: string): Promise<ResourceInventory>;
    setSkillEnabled(name: string, enabled: boolean, cwd?: string): Promise<ResourceInventory>;
    executeExtensionCommand(input: SendPromptInput): Promise<{ handled: boolean }>;
  };
  mcp: {
    overview(cwd?: string): Promise<McpOverview>;
    save(server: SaveMcpServerInput): Promise<McpOverview>;
    remove(key: string, cwd?: string): Promise<McpOverview>;
    connect(key: string, cwd?: string): Promise<McpOverview>;
    disconnect(key: string, cwd?: string): Promise<McpOverview>;
    reconnect(key: string, cwd?: string): Promise<McpOverview>;
  };
  terminal: {
    create(cwd?: string, cols?: number, rows?: number): Promise<TerminalSessionInfo>;
    list(): Promise<TerminalSessionInfo[]>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    onEvent(listener: (event: TerminalEvent) => void): () => void;
  };
  browser: {
    state(): Promise<BrowserState>;
    navigate(url: string): Promise<BrowserState>;
    back(): Promise<BrowserState>;
    forward(): Promise<BrowserState>;
    reload(): Promise<BrowserState>;
    stop(): Promise<BrowserState>;
    setBounds(bounds: BrowserBounds): Promise<void>;
    setVisible(visible: boolean): Promise<BrowserState>;
    startAnnotation(prompt?: string): Promise<BrowserAnnotationCapture>;
    cancelAnnotation(): Promise<void>;
    onEvent(listener: (event: BrowserEvent) => void): () => void;
  };
  plugins: {
    search(query: string, offset?: number): Promise<PluginSearchResult>;
    details(name: string, version?: string): Promise<PluginPackage>;
    list(cwd?: string): Promise<InstalledPlugin[]>;
    install(name: string, version: string): Promise<PluginMutationResult>;
    remove(source: string): Promise<PluginMutationResult>;
    reload(): Promise<{ reloaded: boolean; runtime: PluginRuntimeStatus }>;
    setEnabled(source: string, enabled: boolean, cwd?: string, scope?: "user" | "project"): Promise<PluginMutationResult>;
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
    forkConversation(conversationId: string, entryId?: string): Promise<ConversationHistoryItem>;
    exportConversation(conversationId: string, format: "markdown" | "json"): Promise<ConversationExport>;
    setConversationArchived(conversationId: string, archived: boolean): Promise<void>;
    setConversationTags(conversationId: string, tags: string[]): Promise<void>;
    deleteConversation(conversationId: string): Promise<void>;
    abort(): Promise<void>;
    queue(prompt: string, mode: "steer" | "followUp"): Promise<QueuedMessages>;
    clearQueue(): Promise<QueuedMessages>;
    listChanges(runId?: string): Promise<TaskFileChange[]>;
    acceptChanges(changeIds?: string[]): Promise<TaskFileChange[]>;
    revertChanges(changeIds?: string[]): Promise<TaskFileChange[]>;
    openChange(changeId: string): Promise<void>;
    revealChange(changeId: string): Promise<void>;
    reset(): Promise<void>;
    answerQuestion(callId: string, answer: string): Promise<void>;
    listRecoveries(): Promise<RuntimeRecoveryInfo[]>;
    retryRecovery(id: string): Promise<{ runId: string }>;
    discardRecovery(id: string): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
};
