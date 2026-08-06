import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { piAgentEventTypes, type AgentEvent } from "./events.js";

/** Internal prerelease protocol. Version 0 requires exact-version compatibility. */
export const runtimeProtocolVersion = 0 as const;

export const runtimeCapabilities = [
  "runtime.rpc",
  "runtime.events",
  "runtime.heartbeat",
  "session.lifecycle",
  "session.events",
] as const;

export type KnownRuntimeCapability = typeof runtimeCapabilities[number];
/** Capability identifiers are extensible; unknown optional values are ignored. */
export type RuntimeCapability = string;

export const runtimeMethods = [
  "getModelCatalog", "discoverModels", "send", "executeExtensionCommand",
  "listConversations", "listConversationPage", "loadConversation", "forkConversation",
  "exportConversation", "setConversationArchived", "setConversationTags", "renameConversation",
  "deleteConversation", "abort", "queueMessage", "clearQueue", "listChanges", "changePath",
  "acceptChanges", "revertChanges", "getPermissionRuntime", "getResourceInventory",
  "getContextBudget", "reloadPackages", "refreshCapabilities", "getPluginRuntime",
  "answerQuestion", "listPlanReviews", "resolvePlanReview", "reset", "testConfiguration",
  "updateConfiguration",
] as const;

export type RuntimeMethod = typeof runtimeMethods[number];

export type RuntimeErrorCode =
  | "incompatible_version"
  | "unsupported_capability"
  | "unknown_method"
  | "malformed_payload"
  | "internal_error";

export type RuntimeProtocolError = {
  code: RuntimeErrorCode;
  message: string;
  stack?: string;
  details?: unknown;
};

type VersionedEnvelope = { protocolVersion: typeof runtimeProtocolVersion };

export type RuntimeRequest = VersionedEnvelope & {
  kind: "runtime.request";
  id: string;
  method: RuntimeMethod;
  args: unknown[];
};

export type RuntimeResponse = VersionedEnvelope & { kind: "runtime.response"; id: string } & (
  | { result?: unknown; error?: never }
  | { result?: never; error: RuntimeProtocolError }
);

export type RuntimeEventMessage = VersionedEnvelope & { kind: "runtime.event"; event: AgentEvent };

export type RuntimeReadyMessage = VersionedEnvelope & {
  kind: "runtime.ready";
  pid: number;
  capabilities: RuntimeCapability[];
};

export type RuntimePing = VersionedEnvelope & { kind: "runtime.ping"; id: string };
export type RuntimePong = VersionedEnvelope & { kind: "runtime.pong"; id: string };

export type RuntimeClientEnvelope = RuntimeRequest | RuntimePing;
export type RuntimeServerEnvelope = RuntimeResponse | RuntimeEventMessage | RuntimeReadyMessage | RuntimePong;

export type RuntimeHandshakeOffer = {
  protocolVersion: typeof runtimeProtocolVersion;
  capabilities: RuntimeCapability[];
  requiredCapabilities: RuntimeCapability[];
};

export type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; error: RuntimeProtocolError };

const identifierSchema = Type.String({ minLength: 1, maxLength: 256 });
const versionSchema = Type.Literal(runtimeProtocolVersion);
const capabilitySchema = Type.String({ pattern: "^[a-z][a-z0-9.-]{0,127}$" });
const methodSchema = Type.Union(runtimeMethods.map((method) => Type.Literal(method)));
const optionalConversationId = Type.Optional(identifierSchema);
const unknownObjectSchema = Type.Object({}, { additionalProperties: true });
const runBase = { conversationId: optionalConversationId, runId: identifierSchema };
const questionOptionSchema = Type.Object({
  label: Type.String({ maxLength: 2_000 }),
  description: Type.Optional(Type.String({ maxLength: 8_000 })),
}, { additionalProperties: false });
const usageSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 256 }),
  model: Type.String({ minLength: 1, maxLength: 512 }),
  responseModel: Type.Optional(Type.String({ maxLength: 512 })),
  inputTokens: Type.Number({ minimum: 0 }), outputTokens: Type.Number({ minimum: 0 }),
  cacheReadTokens: Type.Number({ minimum: 0 }), cacheWriteTokens: Type.Number({ minimum: 0 }),
  totalTokens: Type.Number({ minimum: 0 }), requestCount: Type.Number({ minimum: 0 }),
  cost: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });
const conversationItemSchema = Type.Object({
  id: identifierSchema,
  title: Type.String(),
  cwd: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  tags: Type.Array(Type.String()),
  archived: Type.Boolean(),
  searchText: Type.String(),
  parentConversationId: Type.Optional(identifierSchema),
  project: Type.Optional(Type.Object({ id: identifierSchema, name: Type.String(), path: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });

export const agentEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("runtime.status"), status: Type.Union([Type.Literal("running"), Type.Literal("crash-looping"), Type.Literal("unresponsive")]), conversationId: optionalConversationId }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("run.started"), runId: identifierSchema, conversationId: identifierSchema, provider: Type.String(), model: Type.String(), cwd: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("user.message.started"), ...runBase, message: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("message.delta"), ...runBase, text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("thinking.delta"), ...runBase, text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("tool.started"), ...runBase, callId: identifierSchema, name: Type.String(), args: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("tool.updated"), ...runBase, callId: identifierSchema, name: Type.String(), output: Type.String(), details: Type.Optional(unknownObjectSchema) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("tool.completed"), ...runBase, callId: identifierSchema, name: Type.String(), output: Type.String(), isError: Type.Boolean(), details: Type.Optional(unknownObjectSchema) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("question.requested"), ...runBase, callId: identifierSchema, question: Type.String(), options: Type.Array(questionOptionSchema) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("plan.review.draft"), ...runBase, draft: unknownObjectSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("plan.review.requested"), ...runBase, review: unknownObjectSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("plan.review.resolved"), ...runBase, review: unknownObjectSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("response.usage"), ...runBase, usage: usageSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("context.updated"), ...runBase, usage: Type.Object({ tokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), contextWindow: Type.Number({ minimum: 1 }), percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("queue.updated"), ...runBase, queue: Type.Object({ steering: Type.Array(Type.String()), followUp: Type.Array(Type.String()) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("changes.updated"), ...runBase, changes: Type.Array(unknownObjectSchema) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("agent.event"), ...runBase, event: Type.Object({ sequence: Type.Integer({ minimum: 0 }), timestamp: Type.Number({ minimum: 0 }), eventType: Type.Union(piAgentEventTypes.map((type) => Type.Literal(type))), payload: Type.Unknown() }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("conversation.updated"), kind: Type.Literal("upsert"), reason: Type.Union([Type.Literal("run-completed"), Type.Literal("run-error"), Type.Literal("run-stopped"), Type.Literal("renamed"), Type.Literal("tags-changed"), Type.Literal("archive-changed"), Type.Literal("forked")]), conversation: conversationItemSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("conversation.updated"), kind: Type.Literal("delete"), reason: Type.Literal("deleted"), conversationId: identifierSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("run.completed"), ...runBase }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("run.stopped"), ...runBase }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("run.error"), ...runBase, message: Type.String() }, { additionalProperties: false }),
]);

export const runtimeRequestSchema = Type.Object({
  kind: Type.Literal("runtime.request"),
  protocolVersion: versionSchema,
  id: identifierSchema,
  method: methodSchema,
  args: Type.Array(Type.Unknown(), { maxItems: 64 }),
}, { additionalProperties: false });

const runtimeErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal("incompatible_version"), Type.Literal("unsupported_capability"),
    Type.Literal("unknown_method"), Type.Literal("malformed_payload"), Type.Literal("internal_error"),
  ]),
  message: Type.String({ minLength: 1, maxLength: 16_384 }),
  stack: Type.Optional(Type.String({ maxLength: 256_000 })),
  details: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

export const runtimeResponseSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("runtime.response"), protocolVersion: versionSchema,
    id: identifierSchema, result: Type.Optional(Type.Unknown()),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("runtime.response"), protocolVersion: versionSchema,
    id: identifierSchema, error: runtimeErrorSchema,
  }, { additionalProperties: false }),
]);

export const runtimeEventMessageSchema = Type.Object({
  kind: Type.Literal("runtime.event"),
  protocolVersion: versionSchema,
  event: agentEventSchema,
}, { additionalProperties: false });

export const runtimeReadyMessageSchema = Type.Object({
  kind: Type.Literal("runtime.ready"),
  protocolVersion: versionSchema,
  pid: Type.Integer({ minimum: 1 }),
  capabilities: Type.Array(capabilitySchema, { uniqueItems: true, maxItems: 128 }),
}, { additionalProperties: false });

export const runtimePingSchema = Type.Object({
  kind: Type.Literal("runtime.ping"), protocolVersion: versionSchema, id: identifierSchema,
}, { additionalProperties: false });

export const runtimePongSchema = Type.Object({
  kind: Type.Literal("runtime.pong"), protocolVersion: versionSchema, id: identifierSchema,
}, { additionalProperties: false });

export const runtimeHandshakeOfferSchema = Type.Object({
  protocolVersion: versionSchema,
  capabilities: Type.Array(capabilitySchema, { uniqueItems: true, maxItems: 128 }),
  requiredCapabilities: Type.Array(capabilitySchema, { uniqueItems: true, maxItems: 128 }),
}, { additionalProperties: false });

export const runtimeClientEnvelopeSchema = Type.Union([runtimeRequestSchema, runtimePingSchema]);
export const runtimeServerEnvelopeSchema = Type.Union([
  runtimeResponseSchema, runtimeEventMessageSchema, runtimeReadyMessageSchema, runtimePongSchema,
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function optionalString(value: unknown): boolean {
  return absent(value) || typeof value === "string";
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function optionalStringArray(value: unknown): boolean {
  return absent(value) || stringArray(value);
}

function object(value: unknown): boolean {
  return record(value) !== undefined;
}

function optionalObject(value: unknown): boolean {
  return absent(value) || object(value);
}

function exact(args: unknown[], length: number, ...checks: Array<(value: unknown) => boolean>): boolean {
  return args.length === length && checks.every((check, index) => check(args[index]));
}

const runtimeMethodArgsValidators = {
  getModelCatalog: (args) => exact(args, 1, (value) => typeof value === "boolean"),
  discoverModels: (args) => exact(args, 1, object),
  send: (args) => (args.length === 3 || args.length === 4)
    && typeof args[0] === "string" && optionalString(args[1]) && optionalString(args[2])
    && (args.length === 3 || optionalObject(args[3])),
  executeExtensionCommand: (args) => exact(args, 3, (value) => typeof value === "string", optionalString, optionalString),
  listConversations: (args) => exact(args, 0),
  listConversationPage: (args) => exact(args, 1, optionalObject),
  loadConversation: (args) => exact(args, 1, (value) => typeof value === "string"),
  forkConversation: (args) => exact(args, 2, (value) => typeof value === "string", optionalString),
  exportConversation: (args) => exact(args, 2, (value) => typeof value === "string", (value) => value === "markdown" || value === "json"),
  setConversationArchived: (args) => exact(args, 2, (value) => typeof value === "string", (value) => typeof value === "boolean"),
  setConversationTags: (args) => exact(args, 2, (value) => typeof value === "string", stringArray),
  renameConversation: (args) => exact(args, 2, (value) => typeof value === "string", (value) => typeof value === "string"),
  deleteConversation: (args) => exact(args, 1, (value) => typeof value === "string"),
  abort: (args) => exact(args, 0),
  queueMessage: (args) => (args.length === 2 || args.length === 3)
    && typeof args[0] === "string" && (args[1] === "steer" || args[1] === "followUp")
    && (args.length === 2 || optionalObject(args[2])),
  clearQueue: (args) => exact(args, 0),
  listChanges: (args) => exact(args, 1, optionalString),
  changePath: (args) => exact(args, 1, (value) => typeof value === "string"),
  acceptChanges: (args) => exact(args, 1, optionalStringArray),
  revertChanges: (args) => exact(args, 1, optionalStringArray),
  getPermissionRuntime: (args) => exact(args, 0),
  getResourceInventory: (args) => exact(args, 1, optionalString),
  getContextBudget: (args) => exact(args, 1, optionalString),
  reloadPackages: (args) => exact(args, 0),
  refreshCapabilities: (args) => exact(args, 0),
  getPluginRuntime: (args) => exact(args, 0),
  answerQuestion: (args) => exact(args, 2, (value) => typeof value === "string", (value) => typeof value === "string"),
  listPlanReviews: (args) => exact(args, 1, optionalString),
  resolvePlanReview: (args) => exact(args, 1, object),
  reset: (args) => exact(args, 0),
  testConfiguration: (args) => exact(args, 1, object),
  updateConfiguration: (args) => exact(args, 1, object),
} satisfies Record<RuntimeMethod, (args: unknown[]) => boolean>;

export function validateRuntimeMethodArgs(method: RuntimeMethod, args: unknown[]): boolean {
  return runtimeMethodArgsValidators[method](args);
}

function failureFor(value: unknown, expectedKind: string): RuntimeProtocolError {
  const input = record(value);
  if (input?.protocolVersion !== undefined && input.protocolVersion !== runtimeProtocolVersion) {
    return { code: "incompatible_version", message: `Unsupported runtime protocol version ${String(input.protocolVersion)}.` };
  }
  if (input?.kind === "runtime.request" && typeof input.method === "string" && !runtimeMethods.includes(input.method as RuntimeMethod)) {
    return { code: "unknown_method", message: `Unknown runtime method ${input.method}.` };
  }
  return { code: "malformed_payload", message: `Malformed ${expectedKind} payload.` };
}

function validate<T>(schema: TSchema, value: unknown, expectedKind: string): ValidationResult<T> {
  return Check(schema, value)
    ? { success: true, value: value as T }
    : { success: false, error: failureFor(value, expectedKind) };
}

export function validateRuntimeRequest(value: unknown): ValidationResult<RuntimeRequest> {
  const result = validate<RuntimeRequest>(runtimeRequestSchema, value, "runtime.request");
  if (!result.success || validateRuntimeMethodArgs(result.value.method, result.value.args)) return result;
  return { success: false, error: { code: "malformed_payload", message: `Malformed arguments for runtime method ${result.value.method}.` } };
}

export function validateRuntimeClientEnvelope(value: unknown): ValidationResult<RuntimeClientEnvelope> {
  const result = validate<RuntimeClientEnvelope>(runtimeClientEnvelopeSchema, value, "runtime client envelope");
  if (!result.success || result.value.kind !== "runtime.request" || validateRuntimeMethodArgs(result.value.method, result.value.args)) return result;
  return { success: false, error: { code: "malformed_payload", message: `Malformed arguments for runtime method ${result.value.method}.` } };
}

export function validateRuntimeServerEnvelope(value: unknown): ValidationResult<RuntimeServerEnvelope> {
  return validate(runtimeServerEnvelopeSchema, value, "runtime server envelope");
}

export function validateRuntimeHandshakeOffer(value: unknown): ValidationResult<RuntimeHandshakeOffer> {
  return validate(runtimeHandshakeOfferSchema, value, "runtime handshake");
}

export function negotiateRuntimeCapabilities(
  offer: RuntimeHandshakeOffer,
  supported: readonly RuntimeCapability[] = runtimeCapabilities,
): ValidationResult<RuntimeCapability[]> {
  if (offer.protocolVersion !== runtimeProtocolVersion) {
    return { success: false, error: { code: "incompatible_version", message: `Unsupported runtime protocol version ${offer.protocolVersion}.` } };
  }
  const supportedSet = new Set(supported);
  const offeredSet = new Set(offer.capabilities);
  const missing = offer.requiredCapabilities.filter((capability) => !offeredSet.has(capability) || !supportedSet.has(capability));
  if (missing.length > 0) {
    return { success: false, error: { code: "unsupported_capability", message: `Required runtime capabilities are unavailable: ${missing.join(", ")}.`, details: missing } };
  }
  return { success: true, value: offer.capabilities.filter((capability) => supportedSet.has(capability)) };
}
