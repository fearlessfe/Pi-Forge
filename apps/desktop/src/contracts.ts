import type {
  AgentEvent,
  AgentRuntimeStatus,
  ConversationExport,
  ConversationHistoryDetail,
  ConversationHistoryItem,
  ConversationHistoryPage,
  ConversationListQuery,
  PlanReviewArtifact,
  PromptFileAttachment,
  PromptImage,
  QueuedMessages,
  ResolvePlanReviewInput,
  RuntimeRecoveryInfo,
  SendPromptInput,
  TaskFileChange,
} from "@pi-forge/runtime-contracts";

export type {
  AgentEvent,
  AgentRuntimeStatus,
  AgentTraceEvent,
  ContextUsageInfo,
  ConversationActivity,
  ConversationExport,
  ConversationHistoryDetail,
  ConversationHistoryItem,
  ConversationHistoryPage,
  ConversationHistoryTurn,
  ConversationListQuery,
  ConversationUpdatedEvent,
  PiAgentEventType,
  PlanReviewAnnotation,
  PlanReviewArtifact,
  PlanReviewDecision,
  PlanReviewDraft,
  PlanReviewVersion,
  PromptFileAttachment,
  PromptImage,
  QuestionOption,
  QueuedMessages,
  ResolvePlanReviewInput,
  ResponseUsage,
  RuntimeRecoveryInfo,
  SendPromptInput,
  SubagentRunInfo,
  TaskFileChange,
  ToolActivityDetails,
  TurnAttachment,
} from "@pi-forge/runtime-contracts";

export const compatibleProviderIds = [
  "openai-compatible",
  "openai-responses-compatible",
  "anthropic-compatible",
  "google-compatible",
] as const;

export type ProviderId = string;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PermissionMode = "balanced" | "strict";

/** 已解析的界面主题；用于窗口/原生视图的实际配色。 */
export type AppearanceTheme = "dark" | "light";

/** 用户外观偏好；system 跟随 macOS/Windows 的系统外观。 */
export type AppearancePreference = AppearanceTheme | "system";

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

export type ProjectResourceSettings = {
  cwd: string;
  selectionMode: "inherit" | "custom";
  selectedSkills: string[];
  selectedMcpServers: string[];
  skillOverrides: Record<string, boolean>;
  mcpServerOverrides: Record<string, boolean>;
};

export type ProjectResourceSelection = {
  skills: string[];
  mcpServers: string[];
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
  globalEnabled: boolean;
  projectEnabled?: boolean;
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
  projectSettings: ProjectResourceSettings;
  trust: WorkspaceTrustStatus;
  skills: SkillResourceInfo[];
  diagnostics: ResourceDiagnosticInfo[];
  commands: CommandInfo[];
};

export type ContextBudgetCategory = "systemPrompt" | "agents" | "skills" | "prompts" | "extensions" | "mcpSchemas";

export type ContextBudgetLoadMode = "baseline" | "on-demand" | "mixed";

export type ContextBudgetItem = {
  id: string;
  category: ContextBudgetCategory;
  name: string;
  source: string;
  scope: "user" | "project" | "temporary" | "runtime";
  enabled: boolean;
  disableSupported: boolean;
  loadMode: ContextBudgetLoadMode;
  estimateStatus: "estimated" | "unavailable";
  baselineEstimatedTokens: number;
  onDemandEstimatedTokens: number;
  estimatedTokens: number;
  estimatedSavingsTokens: number;
};

export type ContextBudgetGroup = {
  category: ContextBudgetCategory;
  enabledItems: number;
  totalItems: number;
  baselineEstimatedTokens: number;
  onDemandEstimatedTokens: number;
  estimatedTokens: number;
  availableEstimatedTokens: number;
  estimatedSavingsTokens: number;
  items: ContextBudgetItem[];
};

export type ContextBudgetEstimator = {
  id: "anthropic-tokenizer-v1" | "gpt-tokenizer-o200k-v1" | "gpt-tokenizer-cl100k-v1" | "utf8-bytes-v1";
  kind: "model-tokenizer" | "fallback";
  provider: string;
  model: string;
  tokenizer: string;
  local: true;
  bytesPerToken?: 4;
};

export type ContextBudgetSnapshot = {
  id: string;
  cwd: string;
  conversationId: string;
  runId: string;
  createdAt: string;
  provider: string;
  model: string;
  estimatorId: ContextBudgetEstimator["id"];
  estimateBasis: "baseline" | "potential";
  estimatedResourceTokens: number;
  actualInputTokens: number;
  actualContextTokens: number | null;
  deltaTokens: number;
  estimatedSharePercent: number | null;
};

export type ContextBudgetReport = {
  cwd: string;
  estimator: ContextBudgetEstimator;
  /** Complete fixed context sent before conversation messages: assembled system prompt + active tool schemas. */
  baselineEstimatedTokens: number;
  systemPromptEstimatedTokens: number;
  toolSchemaEstimatedTokens: number;
  activeToolCount: number;
  /** Resource-only baseline used for attribution; these tokens are already included in the assembled context. */
  resourceBaselineEstimatedTokens: number;
  onDemandEstimatedTokens: number;
  /** Complete fixed context plus currently enabled on-demand resource bodies. */
  totalEstimatedTokens: number;
  availableEstimatedTokens: number;
  estimatedSavingsTokens: number;
  groups: ContextBudgetGroup[];
  history: ContextBudgetSnapshot[];
};

export type ContextBudgetRequest = {
  cwd?: string;
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
  projectEnabled?: boolean;
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

/** Persisted per-conversation execution choices. Credentials are deliberately excluded. */
export type ConversationExecutionProfile = {
  version: 1;
  conversationId: string;
  provider: ProviderId;
  baseUrl: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  resourceSelectionMode: "inherit" | "custom";
  selectedSkills: string[];
  selectedMcpServers: string[];
  updatedAt: string;
};

export type SaveConversationExecutionProfile = Pick<ConversationExecutionProfile,
  "conversationId" | "provider" | "baseUrl" | "modelId" | "thinkingLevel" | "cwd" | "resourceSelectionMode" | "selectedSkills" | "selectedMcpServers"
>;

export type ModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Whether the model accepts image input; undefined means unknown (allowed). */
  supportsImages?: boolean;
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

export type RendererRecoverySnapshot = {
  events: AgentEvent[];
  runtimeStatus?: AgentRuntimeStatus;
  runtimeStatuses: Record<string, AgentRuntimeStatus>;
};

/** 随消息发送的图片附件；data 为不含 data: URL 前缀的 base64。 */
/** IPC 与 Agent Runtime 共同执行的消息附件资源上限。 */
export const maxPromptImageBytes = 10 * 1024 * 1024;
export const maxPromptImagesPerMessage = 8;
export const maxPromptImageTotalBytes = 32 * 1024 * 1024;
export const maxPromptTextAttachmentBytes = 1024 * 1024;
export const maxPromptTextAttachmentsPerMessage = 10;
export const maxPromptTextAttachmentTotalBytes = 5 * 1024 * 1024;
export const maxPromptAttachmentNameBytes = 512;
export const maxPromptMimeTypeLength = 128;
export const supportedPromptImageMimeTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** 文本附件超过此 UTF-8 字节数时，只向模型提供引用并通过工具按需读取。 */
export const inlineTextAttachmentMaxBytes = 64 * 1024;

export type QueuePromptInput = {
  conversationId: string;
  prompt: string;
  mode: "steer" | "followUp";
  images?: PromptImage[];
  attachments?: PromptFileAttachment[];
};

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserMode = "persistent" | "private";

export type BrowserDataType = "cookies" | "cache" | "storage";

export type BrowserClearDataInput = {
  mode: BrowserMode;
  dataTypes: BrowserDataType[];
};

export type BrowserState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  annotating: boolean;
  mode: BrowserMode;
  error?: string;
};

export type BrowserScreenshotMetadata = {
  id: string;
  owner: string;
  path: string;
  createdAt: string;
  expiresAt: string;
  ttlMs: number;
  byteSize: number;
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
  screenshot?: BrowserScreenshotMetadata;
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

export type PluginSecuritySeverity = "critical" | "high" | "medium" | "low";
export type PluginSecurityConfidence = "high" | "medium";
export type PluginSecurityCategory =
  | "secrets"
  | "hidden-content"
  | "prompt-injection"
  | "permissions"
  | "execution"
  | "network"
  | "mcp"
  | "coverage";

export type PluginSecurityFinding = {
  ruleId: string;
  category: PluginSecurityCategory;
  severity: PluginSecuritySeverity;
  confidence: PluginSecurityConfidence;
  path: string;
  line: number;
  message: string;
  remediation: string;
};

export type PluginContentScanReport = {
  scannerVersion: 1;
  status: "clean" | "review" | "blocked";
  scannedAt: string;
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  truncated: boolean;
  findings: PluginSecurityFinding[];
};

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
  securityScan?: PluginContentScanReport;
  verification: "verified" | "legacy" | "missing" | "tampered";
};

export type PluginProgressEvent = {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  phase?: "resolving" | "downloading" | "verifying" | "scanning" | "staging" | "installing-dependencies" | "publishing" | "ready";
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
  appearance: {
    nativeMaterial: boolean;
    setTheme(preference: AppearancePreference, resolvedTheme: AppearanceTheme): Promise<AppearanceTheme>;
  };
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
    openFile(cwd: string, reference: string): Promise<void>;
  };
  resources: {
    getSettings(): Promise<ResourceSettings>;
    saveSettings(settings: ResourceSettings): Promise<ResourceSettings>;
    inventory(cwd?: string): Promise<ResourceInventory>;
    contextBudget(input?: ContextBudgetRequest): Promise<ContextBudgetReport>;
    setSkillEnabled(name: string, enabled: boolean, cwd?: string, scope?: "user" | "project"): Promise<ResourceInventory>;
    setProjectSelection(cwd: string, selection?: ProjectResourceSelection): Promise<ProjectResourceSettings>;
    executeExtensionCommand(input: SendPromptInput): Promise<{ handled: boolean }>;
  };
  mcp: {
    overview(cwd?: string): Promise<McpOverview>;
    save(server: SaveMcpServerInput): Promise<McpOverview>;
    remove(key: string, cwd?: string): Promise<McpOverview>;
    connect(key: string, cwd?: string): Promise<McpOverview>;
    disconnect(key: string, cwd?: string): Promise<McpOverview>;
    reconnect(key: string, cwd?: string): Promise<McpOverview>;
    setProjectEnabled(key: string, enabled: boolean, cwd: string): Promise<McpOverview>;
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
    openExternal(url: string): Promise<void>;
    back(): Promise<BrowserState>;
    forward(): Promise<BrowserState>;
    reload(): Promise<BrowserState>;
    stop(): Promise<BrowserState>;
    setMode(mode: BrowserMode): Promise<BrowserState>;
    clearData(input: BrowserClearDataInput): Promise<BrowserState>;
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
    listConversationPage(query?: ConversationListQuery): Promise<ConversationHistoryPage>;
    loadConversation(conversationId: string): Promise<ConversationHistoryDetail>;
    renameConversation(conversationId: string, title: string): Promise<void>;
    forkConversation(conversationId: string, entryId?: string): Promise<ConversationHistoryItem>;
    exportConversation(conversationId: string, format: "markdown" | "json"): Promise<ConversationExport>;
    setConversationArchived(conversationId: string, archived: boolean): Promise<void>;
    setConversationTags(conversationId: string, tags: string[]): Promise<void>;
    deleteConversation(conversationId: string): Promise<void>;
    getProfile(conversationId: string, cwd?: string): Promise<ConversationExecutionProfile>;
    saveProfile(profile: SaveConversationExecutionProfile): Promise<ConversationExecutionProfile>;
    abort(conversationId: string): Promise<void>;
    queue(input: QueuePromptInput): Promise<QueuedMessages>;
    clearQueue(conversationId: string): Promise<QueuedMessages>;
    listChanges(conversationId: string, runId?: string): Promise<TaskFileChange[]>;
    acceptChanges(conversationId: string, changeIds?: string[]): Promise<TaskFileChange[]>;
    revertChanges(conversationId: string, changeIds?: string[]): Promise<TaskFileChange[]>;
    openChange(conversationId: string, changeId: string): Promise<void>;
    revealChange(conversationId: string, changeId: string): Promise<void>;
    reset(conversationId: string): Promise<void>;
    answerQuestion(conversationId: string, callId: string, answer: string): Promise<void>;
    listPlanReviews(conversationId?: string): Promise<PlanReviewArtifact[]>;
    resolvePlanReview(conversationId: string, input: ResolvePlanReviewInput): Promise<PlanReviewArtifact>;
    listRecoveries(): Promise<RuntimeRecoveryInfo[]>;
    retryRecovery(id: string): Promise<{ runId: string }>;
    discardRecovery(id: string): Promise<void>;
    retryRuntime(conversationId?: string): Promise<void>;
    reconnect(): Promise<RendererRecoverySnapshot>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
};
