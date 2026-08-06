import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  negotiateRuntimeCapabilities,
  runtimeCapabilities,
  runtimeMethods,
  runtimeProtocolVersion,
  validateRuntimeRequest,
  validateRuntimeClientEnvelope,
  validateRuntimeServerEnvelope,
  type RuntimeMethod,
  type RuntimeRequest,
  type RuntimeServerEnvelope,
} from "./index.js";

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url)), "utf8"));
}

describe("runtime contract v0 fixtures", () => {
  it.each(["v0/runtime-ready.json", "v0/runtime-event.json"])("validates and round-trips %s", (path) => {
    const input = fixture(path);
    const parsed = validateRuntimeServerEnvelope(input);
    expect(parsed).toEqual({ success: true, value: input });
    expect(validateRuntimeServerEnvelope(JSON.parse(JSON.stringify(parsed.success ? parsed.value : null)))).toEqual(parsed);
  });

  it("validates and round-trips request envelopes", () => {
    const input = fixture("v0/runtime-request.json");
    const parsed = validateRuntimeRequest(input);
    expect(parsed).toEqual({ success: true, value: input });
    expect(validateRuntimeRequest(JSON.parse(JSON.stringify(parsed.success ? parsed.value : null)))).toEqual(parsed);
  });

  it("rejects incompatible versions, unknown methods, and malformed payloads", () => {
    expect(validateRuntimeRequest(fixture("incompatible/runtime-request-v1.json"))).toMatchObject({
      success: false,
      error: { code: "incompatible_version" },
    });
    expect(validateRuntimeRequest({
      kind: "runtime.request", protocolVersion: runtimeProtocolVersion, id: "r", method: "futureMethod", args: [],
    })).toMatchObject({ success: false, error: { code: "unknown_method" } });
    expect(validateRuntimeClientEnvelope({
      kind: "runtime.request", protocolVersion: runtimeProtocolVersion, id: "r", method: "futureMethod", args: [],
    })).toMatchObject({ success: false, error: { code: "unknown_method" } });
    expect(validateRuntimeRequest({
      kind: "runtime.request", protocolVersion: runtimeProtocolVersion, id: "r", method: "send", args: "nope",
    })).toMatchObject({ success: false, error: { code: "malformed_payload" } });
    expect(validateRuntimeClientEnvelope({
      kind: "runtime.request", protocolVersion: runtimeProtocolVersion, id: "r", method: "send", args: [],
    })).toMatchObject({ success: false, error: { code: "malformed_payload", message: expect.stringContaining("send") } });
  });

  it("rejects malformed server envelopes instead of accepting partial discriminants", () => {
    expect(validateRuntimeServerEnvelope({ kind: "runtime.ready", protocolVersion: 0, pid: "42", capabilities: [] }))
      .toMatchObject({ success: false, error: { code: "malformed_payload" } });
    expect(validateRuntimeServerEnvelope({ kind: "runtime.event", protocolVersion: 0, event: { type: "future.event" } }))
      .toMatchObject({ success: false, error: { code: "malformed_payload" } });
  });
});

describe("runtime compatibility negotiation", () => {
  it("negotiates the intersection and enforces required capabilities", () => {
    const offer = {
      protocolVersion: runtimeProtocolVersion,
      capabilities: [...runtimeCapabilities],
      requiredCapabilities: ["runtime.rpc", "runtime.events"] as const,
    };
    expect(negotiateRuntimeCapabilities(offer, ["runtime.rpc", "runtime.events", "runtime.heartbeat"]))
      .toEqual({ success: true, value: ["runtime.rpc", "runtime.events", "runtime.heartbeat"] });
    expect(negotiateRuntimeCapabilities(offer, ["runtime.rpc"]))
      .toMatchObject({ success: false, error: { code: "unsupported_capability" } });
  });

  it("ignores unknown optional capabilities and rejects unknown required capabilities", () => {
    expect(negotiateRuntimeCapabilities({
      protocolVersion: runtimeProtocolVersion,
      capabilities: ["runtime.rpc", "vendor.future"],
      requiredCapabilities: ["runtime.rpc"],
    })).toEqual({ success: true, value: ["runtime.rpc"] });
    expect(negotiateRuntimeCapabilities({
      protocolVersion: runtimeProtocolVersion,
      capabilities: ["runtime.rpc", "vendor.required"],
      requiredCapabilities: ["runtime.rpc", "vendor.required"],
    })).toMatchObject({ success: false, error: { code: "unsupported_capability", details: ["vendor.required"] } });
    expect(negotiateRuntimeCapabilities({
      protocolVersion: runtimeProtocolVersion,
      capabilities: ["runtime.rpc"],
      requiredCapabilities: ["runtime.rpc", "runtime.events"],
    })).toMatchObject({ success: false, error: { code: "unsupported_capability", details: ["runtime.events"] } });
  });

  it("keeps method and envelope unions exhaustive at compile time", () => {
    const allMethods: Record<RuntimeMethod, true> = Object.fromEntries(runtimeMethods.map((method) => [method, true])) as Record<RuntimeMethod, true>;
    expect(Object.keys(allMethods)).toHaveLength(runtimeMethods.length);
    expectTypeOf<RuntimeRequest["method"]>().toEqualTypeOf<RuntimeMethod>();
    expectTypeOf<RuntimeServerEnvelope["kind"]>().toEqualTypeOf<"runtime.response" | "runtime.event" | "runtime.ready" | "runtime.pong">();
  });

  it("validates one compatible argument fixture for every runtime method", () => {
    const validArgs: Record<RuntimeMethod, unknown[]> = {
      getModelCatalog: [true], discoverModels: [{}], send: ["prompt", null, null],
      executeExtensionCommand: ["/help", null, null], listConversations: [], listConversationPage: [null],
      loadConversation: ["conversation"], forkConversation: ["conversation", null], exportConversation: ["conversation", "json"],
      setConversationArchived: ["conversation", true], setConversationTags: ["conversation", ["tag"]],
      renameConversation: ["conversation", "title"], deleteConversation: ["conversation"], abort: [],
      queueMessage: ["next", "followUp"], clearQueue: [], listChanges: [null], changePath: ["change"],
      acceptChanges: [null], revertChanges: [["change"]], getPermissionRuntime: [], getResourceInventory: [null],
      getContextBudget: [null], reloadPackages: [], refreshCapabilities: [], getPluginRuntime: [],
      answerQuestion: ["call", "answer"], listPlanReviews: [null], resolvePlanReview: [{}], reset: [],
      testConfiguration: [{}], updateConfiguration: [{}],
    };
    for (const method of runtimeMethods) {
      expect(validateRuntimeRequest({
        kind: "runtime.request", protocolVersion: runtimeProtocolVersion, id: `request-${method}`, method, args: validArgs[method],
      })).toMatchObject({ success: true });
    }
  });
});
