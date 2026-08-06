import {
  runtimeCapabilities,
  runtimeProtocolVersion,
  validateRuntimeClientEnvelope,
  validateRuntimeServerEnvelope,
  type AgentEvent,
  type RuntimeCapability,
  type RuntimeProtocolError,
  type RuntimeRequest,
  type RuntimeResponse,
} from "@pi-forge/runtime-contracts";
import type { AgentDefinition, AgentManifest, RuntimeHostSend, RuntimeMethodHandlers } from "./types.js";

const packageIdPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  const { manifest } = definition;
  if (!packageIdPattern.test(manifest.id) || manifest.id.length > 214) throw new Error("Agent manifest id is invalid.");
  if (!manifest.name.trim() || manifest.name.length > 128) throw new Error("Agent manifest name is invalid.");
  if (!semverPattern.test(manifest.version)) throw new Error("Agent manifest version must be SemVer.");
  if (manifest.protocolVersion !== runtimeProtocolVersion) throw new Error(`Agent protocolVersion must be ${runtimeProtocolVersion}.`);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > 128
    || new Set(manifest.capabilities).size !== manifest.capabilities.length
    || manifest.capabilities.some((capability) => typeof capability !== "string" || !capabilityPattern.test(capability))) {
    throw new Error("Agent manifest capabilities are invalid.");
  }
  if (!manifest.capabilities.includes("runtime.rpc")) throw new Error("Agent must provide runtime.rpc.");
  if (typeof definition.create !== "function") throw new Error("Agent create factory is required.");
  return definition;
}

export type RuntimeHostOptions = {
  pid?: number;
  capabilities?: RuntimeCapability[];
};

export class RuntimeHost {
  private readonly handlers: RuntimeMethodHandlers;
  private readonly capabilities: RuntimeCapability[];
  private readonly pid: number;
  private started = false;

  constructor(
    private readonly send: RuntimeHostSend,
    readonly definition: AgentDefinition,
    options: RuntimeHostOptions = {},
  ) {
    defineAgent(definition);
    this.capabilities = [...new Set(options.capabilities ?? definition.manifest.capabilities)];
    if (this.capabilities.length > 128 || this.capabilities.some((capability) => !capabilityPattern.test(capability))) {
      throw new Error("Runtime host capabilities are invalid.");
    }
    this.pid = options.pid ?? 1;
    if (!Number.isSafeInteger(this.pid) || this.pid < 1) throw new Error("Runtime host pid is invalid.");
    this.handlers = definition.create({ emit: (event) => this.emit(event) });
  }

  manifest(): AgentManifest {
    return { ...this.definition.manifest, capabilities: [...this.definition.manifest.capabilities] };
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Runtime host was already started.");
    this.started = true;
    await this.send({
      kind: "runtime.ready",
      protocolVersion: runtimeProtocolVersion,
      pid: this.pid,
      capabilities: [...this.capabilities],
    });
  }

  async accept(input: unknown): Promise<void> {
    if (!this.started) throw new Error("Runtime host is not started.");
    const parsed = validateRuntimeClientEnvelope(input);
    if (!parsed.success) {
      const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
      if (raw?.kind === "runtime.request" && typeof raw.id === "string" && raw.id && raw.id.length <= 256) {
        await this.respond({ kind: "runtime.response", protocolVersion: runtimeProtocolVersion, id: raw.id, error: parsed.error });
      }
      return;
    }
    if (parsed.value.kind === "runtime.ping") {
      await this.send({ kind: "runtime.pong", protocolVersion: runtimeProtocolVersion, id: parsed.value.id });
      return;
    }
    await this.handleRequest(parsed.value);
  }

  async emit(event: AgentEvent): Promise<void> {
    if (!this.started) throw new Error("Runtime host is not started.");
    const envelope = { kind: "runtime.event", protocolVersion: runtimeProtocolVersion, event } as const;
    const parsed = validateRuntimeServerEnvelope(envelope);
    if (!parsed.success) throw new Error(parsed.error.message);
    await this.send(parsed.value);
  }

  private async handleRequest(request: RuntimeRequest): Promise<void> {
    const handler = this.handlers[request.method];
    if (!handler) {
      await this.respond({
        kind: "runtime.response",
        protocolVersion: runtimeProtocolVersion,
        id: request.id,
        error: { code: "unsupported_method", message: `Agent does not implement Runtime method ${request.method}.` },
      });
      return;
    }
    try {
      const result = await handler(...request.args);
      await this.respond({ kind: "runtime.response", protocolVersion: runtimeProtocolVersion, id: request.id, result });
    } catch (error) {
      const protocolError: RuntimeProtocolError = error && typeof error === "object" && "protocolError" in error
        ? (error as { protocolError: RuntimeProtocolError }).protocolError
        : {
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          };
      await this.respond({ kind: "runtime.response", protocolVersion: runtimeProtocolVersion, id: request.id, error: protocolError });
    }
  }

  private respond(response: RuntimeResponse): Promise<void> {
    return Promise.resolve(this.send(response));
  }
}

export function defaultRuntimeCapabilities(): RuntimeCapability[] {
  return [...runtimeCapabilities];
}
