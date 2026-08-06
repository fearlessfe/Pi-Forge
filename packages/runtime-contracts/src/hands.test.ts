import { describe, expect, it } from "vitest";
import { handProtocolVersion, isHandDescriptor, isHandInvocation, isHandLease, isHandResult } from "./hands.js";

describe("Runtime v1 Hand contracts", () => {
  it("validates descriptors, leases, invocations, and results fail-closed", () => {
    expect(isHandDescriptor({
      protocolVersion: handProtocolVersion,
      id: "workspace-shell",
      name: "Workspace Shell",
      version: "1.0.0",
      capabilities: ["workspace.read", "workspace.command"],
      executionModes: ["local", "container"],
    })).toBe(true);
    expect(isHandLease({
      protocolVersion: handProtocolVersion,
      leaseId: "lease-1",
      handId: "workspace-shell",
      agentId: "agent-1",
      scopes: ["workspace.read"],
      issuedAt: "2026-08-06T00:00:00.000Z",
      expiresAt: "2026-08-06T01:00:00.000Z",
      status: "active",
    })).toBe(true);
    expect(isHandInvocation({
      protocolVersion: handProtocolVersion,
      invocationId: "invocation-1",
      leaseId: "lease-1",
      operation: "workspace.read",
      arguments: { path: "README.md" },
      idempotencyKey: "read-1",
    })).toBe(true);
    expect(isHandResult({
      protocolVersion: handProtocolVersion,
      invocationId: "invocation-1",
      status: "completed",
      output: "contents",
    })).toBe(true);
    expect(isHandInvocation({ protocolVersion: 1, invocationId: "i", leaseId: "l", operation: "workspace.read", arguments: {}, credential: "secret" })).toBe(false);
    expect(isHandDescriptor({ protocolVersion: 2, id: "h", name: "H", version: "1.0.0", capabilities: [], executionModes: ["local"] })).toBe(false);
  });
});
