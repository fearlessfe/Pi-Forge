import {
  runtimeCapabilities,
  runtimeProtocolVersion,
  type RuntimeCapability,
  type RuntimeClientEnvelope,
  type RuntimeEventMessage,
  type RuntimeHandshakeOffer,
  type RuntimeMethod,
  type RuntimePing,
  type RuntimePong,
  type RuntimeReadyMessage,
  type RuntimeRequest,
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
  type RuntimeRequest,
  type RuntimeResponse,
};

export type AgentRuntimeMethod = RuntimeMethod;

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

export const hostMethods = [
  "credential.read", "credential.list", "credential.write", "credential.delete",
  "mcp.tools", "mcp.contextInventory", "mcp.callTool", "browser.startAnnotation",
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

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
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
