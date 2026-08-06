import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";

export const handProtocolVersion = 1 as const;

export type HandDescriptor = {
  protocolVersion: typeof handProtocolVersion;
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  executionModes: Array<"local" | "container" | "remote">;
};

export type HandLease = {
  protocolVersion: typeof handProtocolVersion;
  leaseId: string;
  handId: string;
  agentId: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
};

export type HandInvocation = {
  protocolVersion: typeof handProtocolVersion;
  invocationId: string;
  leaseId: string;
  operation: string;
  arguments: unknown;
  idempotencyKey?: string;
};

export type HandResult = {
  protocolVersion: typeof handProtocolVersion;
  invocationId: string;
  status: "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: { code: string; message: string; retryable: boolean };
};

const identifier = Type.String({ minLength: 1, maxLength: 256 });
const capability = Type.String({ pattern: "^[a-z][a-z0-9.-]{0,127}$" });
const version = Type.String({ pattern: "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$" });
const timestamp = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$", maxLength: 64 });

export const handDescriptorSchema = Type.Object({
  protocolVersion: Type.Literal(handProtocolVersion),
  id: identifier,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  version,
  capabilities: Type.Array(capability, { uniqueItems: true, maxItems: 128 }),
  executionModes: Type.Array(Type.Union([Type.Literal("local"), Type.Literal("container"), Type.Literal("remote")]), { uniqueItems: true, minItems: 1 }),
}, { additionalProperties: false });

export const handLeaseSchema = Type.Object({
  protocolVersion: Type.Literal(handProtocolVersion),
  leaseId: identifier,
  handId: identifier,
  agentId: identifier,
  scopes: Type.Array(capability, { uniqueItems: true, maxItems: 128 }),
  issuedAt: timestamp,
  expiresAt: timestamp,
  status: Type.Union([Type.Literal("active"), Type.Literal("revoked"), Type.Literal("expired")]),
}, { additionalProperties: false });

export const handInvocationSchema = Type.Object({
  protocolVersion: Type.Literal(handProtocolVersion),
  invocationId: identifier,
  leaseId: identifier,
  operation: capability,
  arguments: Type.Unknown(),
  idempotencyKey: Type.Optional(identifier),
}, { additionalProperties: false });

export const handResultSchema = Type.Object({
  protocolVersion: Type.Literal(handProtocolVersion),
  invocationId: identifier,
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]),
  output: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({
    code: capability,
    message: Type.String({ minLength: 1, maxLength: 16_384 }),
    retryable: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

function validate<T>(schema: TSchema, value: unknown): value is T {
  return Check(schema, value);
}

export function isHandDescriptor(value: unknown): value is HandDescriptor { return validate(handDescriptorSchema, value); }
export function isHandLease(value: unknown): value is HandLease { return validate(handLeaseSchema, value); }
export function isHandInvocation(value: unknown): value is HandInvocation { return validate(handInvocationSchema, value); }
export function isHandResult(value: unknown): value is HandResult { return validate(handResultSchema, value); }
