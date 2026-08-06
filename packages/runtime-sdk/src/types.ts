import type {
  AgentEvent,
  RuntimeCapability,
  RuntimeClientEnvelope,
  RuntimeMethod,
  RuntimeServerEnvelope,
} from "@pi-forge/runtime-contracts";

export type RuntimeClientSend = (message: RuntimeClientEnvelope) => void | Promise<void>;
export type RuntimeHostSend = (message: RuntimeServerEnvelope) => void | Promise<void>;

export type RuntimeMethodHandler = (...args: unknown[]) => unknown | Promise<unknown>;
export type RuntimeMethodHandlers = Partial<Record<RuntimeMethod, RuntimeMethodHandler>>;

export type AgentManifest = {
  id: string;
  name: string;
  version: string;
  protocolVersion: 1;
  capabilities: RuntimeCapability[];
};

export type AgentContext = {
  emit(event: AgentEvent): Promise<void>;
};

export type AgentDefinition = {
  manifest: AgentManifest;
  create(context: AgentContext): RuntimeMethodHandlers;
};
