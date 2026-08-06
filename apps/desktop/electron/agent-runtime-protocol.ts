import {
  runtimeCapabilities,
  runtimeProtocolVersion,
  type RuntimeCapability,
  type RuntimeClientEnvelope as PublicRuntimeClientEnvelope,
  type RuntimeEventMessage,
  type RuntimeHandshakeOffer,
  type RuntimeMethod,
  type RuntimePing,
  type RuntimePong,
  type RuntimeReadyMessage,
  type RuntimeRequest as PublicRuntimeRequest,
  type RuntimeResponse,
  type RuntimeServerEnvelope,
} from "@pi-forge/runtime-contracts";
import type { RuntimeRecoveryInfo } from "../src/contracts.js";

export {
  runtimeCapabilities,
  runtimeProtocolVersion as agentRuntimeProtocolVersion,
  type RuntimeCapability,
  type RuntimeEventMessage,
  type RuntimePing,
  type RuntimePong,
  type RuntimeReadyMessage,
  type RuntimeResponse,
};

export const backgroundSubagentRuntimeMethods = [
  "enqueueSubagent", "listSubagents", "pauseSubagent", "resumeSubagent",
  "retrySubagent", "stopSubagent", "prepareSubagentHandoff",
] as const;

export type AgentRuntimeMethod = RuntimeMethod | typeof backgroundSubagentRuntimeMethods[number];
export type RuntimeRequest = Omit<PublicRuntimeRequest, "method"> & { method: AgentRuntimeMethod };
export type RuntimeClientEnvelope = Exclude<PublicRuntimeClientEnvelope, PublicRuntimeRequest> | RuntimeRequest;

export type RuntimeExecutionProfile = {
  modelSettings: AgentRuntimeInit["modelSettings"];
  cwd: string;
  resourceSelectionMode: "inherit" | "custom";
  selectedSkills: string[];
  selectedMcpServers: string[];
};

export type AgentRuntimeInit = RuntimeHandshakeOffer & {
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
  backgroundSubagentScheduler?: boolean;
};

export type HostMethod =
  | "credential.read"
  | "credential.list"
  | "credential.write"
  | "credential.delete"
  | "mcp.tools"
  | "mcp.contextInventory"
  | "mcp.callTool"
  | "browser.startAnnotation"
  | "subagent.enqueue";

export const hostMethods = [
  "credential.read", "credential.list", "credential.write", "credential.delete",
  "mcp.tools", "mcp.contextInventory", "mcp.callTool", "browser.startAnnotation", "subagent.enqueue",
] as const satisfies readonly HostMethod[];

export type HostRequest = {
  kind: "host.request";
  id: string;
  method: HostMethod;
  args: unknown[];
};

export type HostCancel = { kind: "host.cancel"; id: string };

export type HostResponse = {
  kind: "host.response";
  id: string;
  result?: unknown;
  error?: { message: string; stack?: string };
};

export type ParentToRuntimeMessage =
  | { kind: "runtime.init"; value: AgentRuntimeInit }
  | RuntimeClientEnvelope
  | HostResponse;

export type RuntimeToParentMessage = RuntimeServerEnvelope | HostRequest | HostCancel;

export type RuntimeRecoveryRecord = RuntimeRecoveryInfo;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isBackgroundSubagentRuntimeRequest(value: unknown): value is RuntimeRequest {
  if (!isRecord(value)
    || value.kind !== "runtime.request"
    || value.protocolVersion !== runtimeProtocolVersion
    || !isIdentifier(value.id)
    || !Array.isArray(value.args)
    || value.args.length > 64
    || typeof value.method !== "string") return false;
  if (!backgroundSubagentRuntimeMethods.includes(value.method as typeof backgroundSubagentRuntimeMethods[number])) return false;
  if (value.method === "listSubagents") return value.args.length === 0;
  if (value.method === "prepareSubagentHandoff") {
    return value.args.length === 2 && isIdentifier(value.args[0]) && isIdentifier(value.args[1]);
  }
  if (value.method !== "enqueueSubagent") return value.args.length === 1 && isIdentifier(value.args[0]);
  if (value.args.length !== 1 || !isRecord(value.args[0])) return false;
  const input = value.args[0];
  const model = input.modelSettings;
  return onlyKeys(input, ["parentRunId", "parentConversationId", "toolCallId", "role", "task", "cwd", "modelSettings"])
    && (input.parentRunId === undefined || isIdentifier(input.parentRunId))
    && (input.parentConversationId === undefined || isIdentifier(input.parentConversationId))
    && isIdentifier(input.toolCallId)
    && typeof input.role === "string" && input.role.length > 0 && input.role.length <= 200
    && typeof input.task === "string" && input.task.length > 0 && input.task.length <= 100_000
    && typeof input.cwd === "string" && input.cwd.length > 0 && input.cwd.length <= 32_768
    && (model === undefined || (isRecord(model)
      && onlyKeys(model, ["provider", "baseUrl", "modelId", "thinkingLevel"])
      && isIdentifier(model.provider)
      && typeof model.baseUrl === "string" && model.baseUrl.length > 0 && model.baseUrl.length <= 8_192
      && typeof model.modelId === "string" && model.modelId.length > 0 && model.modelId.length <= 512
      && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(model.thinkingLevel))));
}

export function isHostRequest(value: unknown): value is HostRequest {
  if (!isRecord(value) || value.kind !== "host.request" || !isIdentifier(value.id) || !Array.isArray(value.args)) return false;
  return typeof value.method === "string" && hostMethods.includes(value.method as HostMethod);
}

export function isHostCancel(value: unknown): value is HostCancel {
  return isRecord(value) && value.kind === "host.cancel" && isIdentifier(value.id) && Object.keys(value).length === 2;
}

export function isHostResponse(value: unknown): value is HostResponse {
  if (!isRecord(value) || value.kind !== "host.response" || !isIdentifier(value.id)) return false;
  if (value.error !== undefined) {
    if (!isRecord(value.error) || typeof value.error.message !== "string") return false;
    if (value.error.stack !== undefined && typeof value.error.stack !== "string") return false;
  }
  return Object.keys(value).every((key) => key === "kind" || key === "id" || key === "result" || key === "error");
}

export function createRuntimeHandshakeOffer(): RuntimeHandshakeOffer {
  return {
    protocolVersion: runtimeProtocolVersion,
    capabilities: [...runtimeCapabilities],
    requiredCapabilities: ["runtime.rpc", "runtime.events", "runtime.heartbeat"],
  };
}
