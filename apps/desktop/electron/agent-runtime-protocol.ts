import type { AgentEvent, RuntimeRecoveryInfo } from "../src/contracts.js";

export const agentRuntimeProtocolVersion = 2;

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
};

export type AgentRuntimeMethod =
  | "getModelCatalog"
  | "discoverModels"
  | "send"
  | "executeExtensionCommand"
  | "listConversations"
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
  | RuntimeRequest
  | HostResponse;

export type RuntimeToParentMessage = RuntimeResponse | RuntimeEventMessage | RuntimeReadyMessage | HostRequest | HostCancel;

export type RuntimeRecoveryRecord = RuntimeRecoveryInfo;
