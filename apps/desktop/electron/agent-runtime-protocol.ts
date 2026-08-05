import type { AgentEvent, RuntimeRecoveryInfo } from "../src/contracts.js";

export const agentRuntimeProtocolVersion = 6;

export type RuntimeExecutionProfile = {
  modelSettings: AgentRuntimeInit["modelSettings"];
  cwd: string;
  resourceSelectionMode: "inherit" | "custom";
  selectedSkills: string[];
  selectedMcpServers: string[];
};

export type AgentRuntimeInit = {
  protocolVersion: typeof agentRuntimeProtocolVersion;
  userDataPath: string;
  agentDir: string;
  fallbackCwd: string;
  sessionDir: string;
  modelSettings: {
    provider: string;
    baseUrl: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    apiKey?: string;
  };
  resourceProfile?: Pick<RuntimeExecutionProfile, "resourceSelectionMode" | "selectedSkills" | "selectedMcpServers">;
};

export type AgentRuntimeMethod =
  | "getModelCatalog"
  | "discoverModels"
  | "send"
  | "executeExtensionCommand"
  | "listConversations"
  | "listConversationPage"
  | "loadConversation"
  | "forkConversation"
  | "exportConversation"
  | "setConversationArchived"
  | "setConversationTags"
  | "renameConversation"
  | "deleteConversation"
  | "abort"
  | "queueMessage"
  | "clearQueue"
  | "listChanges"
  | "changePath"
  | "acceptChanges"
  | "revertChanges"
  | "getPermissionRuntime"
  | "getResourceInventory"
  | "getContextBudget"
  | "reloadPackages"
  | "refreshCapabilities"
  | "getPluginRuntime"
  | "answerQuestion"
  | "listPlanReviews"
  | "resolvePlanReview"
  | "reset"
  | "testConfiguration"
  | "updateConfiguration";

export type RuntimeRequest = {
  kind: "runtime.request";
  id: string;
  method: AgentRuntimeMethod;
  args: unknown[];
};

export type RuntimeResponse = {
  kind: "runtime.response";
  id: string;
  result?: unknown;
  error?: { message: string; stack?: string };
};

export type RuntimeEventMessage = {
  kind: "runtime.event";
  event: AgentEvent;
};

export type RuntimeReadyMessage = {
  kind: "runtime.ready";
  protocolVersion: typeof agentRuntimeProtocolVersion;
  pid: number;
};

export type RuntimePing = { kind: "runtime.ping"; id: string };
export type RuntimePong = { kind: "runtime.pong"; id: string };

export type HostMethod =
  | "credential.read"
  | "credential.list"
  | "credential.write"
  | "credential.delete"
  | "mcp.tools"
  | "mcp.contextInventory"
  | "mcp.callTool"
  | "browser.startAnnotation";

export type HostRequest = {
  kind: "host.request";
  id: string;
  method: HostMethod;
  args: unknown[];
};

export type HostCancel = {
  kind: "host.cancel";
  id: string;
};

export type HostResponse = {
  kind: "host.response";
  id: string;
  result?: unknown;
  error?: { message: string; stack?: string };
};

export type ParentToRuntimeMessage =
  | { kind: "runtime.init"; value: AgentRuntimeInit }
  | RuntimePing
  | RuntimeRequest
  | HostResponse;

export type RuntimeToParentMessage = RuntimeResponse | RuntimeEventMessage | RuntimeReadyMessage | RuntimePong | HostRequest | HostCancel;

export type RuntimeRecoveryRecord = RuntimeRecoveryInfo;
