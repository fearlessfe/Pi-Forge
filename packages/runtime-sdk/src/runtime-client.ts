import {
  negotiateRuntimeCapabilities,
  runtimeCapabilities,
  runtimeProtocolVersion,
  validateRuntimeMethodArgs,
  validateRuntimeServerEnvelope,
  type AgentEvent,
  type RuntimeCapability,
  type RuntimeMethod,
  type RuntimeProtocolError,
  type RuntimeRequest,
  type RuntimeResponse,
} from "@pi-forge/runtime-contracts";
import type { RuntimeClientSend } from "./types.js";

export class RuntimeSdkError extends Error {
  constructor(readonly protocolError: RuntimeProtocolError) {
    super(protocolError.message);
    this.name = "RuntimeSdkError";
  }
}

export type RuntimeClientOptions = {
  requiredCapabilities?: RuntimeCapability[];
  supportedCapabilities?: RuntimeCapability[];
  requestTimeoutMs?: number;
  id?: () => string;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingPing = Omit<PendingRequest, "resolve"> & { resolve(): void };

export class RuntimeClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pings = new Map<string, PendingPing>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly requiredCapabilities: RuntimeCapability[];
  private readonly supportedCapabilities: RuntimeCapability[];
  private readonly requestTimeoutMs: number;
  private readonly createId: () => string;
  private readyCapabilities?: RuntimeCapability[];
  private closed = false;
  private idSequence = 0;
  private resolveReady?: (capabilities: RuntimeCapability[]) => void;
  private rejectReady?: (error: Error) => void;
  private readonly readyPromise: Promise<RuntimeCapability[]>;

  constructor(private readonly send: RuntimeClientSend, options: RuntimeClientOptions = {}) {
    this.requiredCapabilities = options.requiredCapabilities ?? ["runtime.rpc", "runtime.events", "runtime.heartbeat"];
    this.supportedCapabilities = options.supportedCapabilities ?? [...runtimeCapabilities];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) throw new Error("Runtime request timeout must be positive.");
    this.createId = options.id ?? (() => `runtime-sdk-${++this.idSequence}`);
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  ready(): Promise<RuntimeCapability[]> {
    return this.readyPromise;
  }

  capabilities(): RuntimeCapability[] | undefined {
    return this.readyCapabilities ? [...this.readyCapabilities] : undefined;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<TResult = unknown>(method: RuntimeMethod, ...args: unknown[]): Promise<TResult> {
    if (this.closed) throw new Error("Runtime client is closed.");
    if (!validateRuntimeMethodArgs(method, args)) throw new RuntimeSdkError({
      code: "malformed_payload",
      message: `Malformed arguments for runtime method ${method}.`,
    });
    await this.ready();
    if (this.closed) throw new Error("Runtime client is closed.");
    const id = this.createId();
    if (!id || id.length > 256 || this.pending.has(id) || this.pings.has(id)) throw new Error("Runtime request ID must be unique, non-empty, and at most 256 characters.");
    const request: RuntimeRequest = { kind: "runtime.request", protocolVersion: runtimeProtocolVersion, id, method, args };
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Runtime request ${method} timed out after ${this.requestTimeoutMs}ms.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as TResult), reject, timer });
      Promise.resolve(this.send(request)).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async ping(): Promise<void> {
    if (this.closed) throw new Error("Runtime client is closed.");
    await this.ready();
    if (this.closed) throw new Error("Runtime client is closed.");
    const id = this.createId();
    if (!id || id.length > 256 || this.pending.has(id) || this.pings.has(id)) throw new Error("Runtime ping ID must be unique, non-empty, and at most 256 characters.");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pings.delete(id);
        reject(new Error(`Runtime ping timed out after ${this.requestTimeoutMs}ms.`));
      }, this.requestTimeoutMs);
      this.pings.set(id, { resolve, reject, timer });
      Promise.resolve(this.send({ kind: "runtime.ping", protocolVersion: runtimeProtocolVersion, id })).catch((error: unknown) => {
        const pending = this.pings.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pings.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  accept(input: unknown): void {
    if (this.closed) return;
    const parsed = validateRuntimeServerEnvelope(input);
    if (!parsed.success) {
      const error = new RuntimeSdkError(parsed.error);
      this.fail(error);
      throw error;
    }
    const message = parsed.value;
    if (message.kind === "runtime.ready") {
      const negotiated = negotiateRuntimeCapabilities({
        protocolVersion: message.protocolVersion,
        capabilities: message.capabilities,
        requiredCapabilities: this.requiredCapabilities,
      }, this.supportedCapabilities);
      if (!negotiated.success) {
        const error = new RuntimeSdkError(negotiated.error);
        this.fail(error);
        throw error;
      }
      this.readyCapabilities = negotiated.value;
      this.resolveReady?.([...negotiated.value]);
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    if (message.kind === "runtime.response") {
      this.acceptResponse(message);
      return;
    }
    if (message.kind === "runtime.pong") {
      const pending = this.pings.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pings.delete(message.id);
      pending.resolve();
      return;
    }
    if (message.kind === "runtime.event") {
      for (const listener of this.listeners) listener(message.event);
    }
  }

  close(reason = "Runtime client closed."): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error(reason));
    this.listeners.clear();
  }

  private acceptResponse(message: RuntimeResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new RuntimeSdkError(message.error));
    else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    this.resolveReady = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pings.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pings.clear();
  }
}
