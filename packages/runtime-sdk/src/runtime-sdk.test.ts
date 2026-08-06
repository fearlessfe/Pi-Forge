import { describe, expect, it, vi } from "vitest";
import { runtimeCapabilities, runtimeProtocolVersion, type RuntimeClientEnvelope, type RuntimeServerEnvelope } from "@pi-forge/runtime-contracts";
import { RuntimeClient, RuntimeSdkError } from "./runtime-client.js";
import { defaultRuntimeCapabilities, defineAgent, RuntimeHost } from "./runtime-host.js";

function harness(overrides: Parameters<typeof defineAgent>[0]["create"] = ({ emit }) => ({
  updateConfiguration: async () => undefined,
  send: async (prompt, cwd, conversationId) => {
    const runId = "run-sdk-1";
    await emit({
      type: "run.started",
      runId,
      conversationId: String(conversationId),
      provider: "sdk-test",
      model: "sdk-test",
      cwd: String(cwd),
    });
    await emit({ type: "message.delta", runId, text: `echo:${String(prompt)}` });
    await emit({ type: "run.completed", runId });
    return runId;
  },
})) {
  let host: RuntimeHost;
  const client = new RuntimeClient((message: RuntimeClientEnvelope) => host.accept(message), {
    id: () => "request-1",
    requestTimeoutMs: 50,
  });
  host = new RuntimeHost((message: RuntimeServerEnvelope) => client.accept(message), defineAgent({
    manifest: {
      id: "sdk-test-agent",
      name: "SDK Test Agent",
      version: "1.0.0",
      protocolVersion: 1,
      capabilities: ["runtime.rpc", "runtime.events", "runtime.heartbeat"],
    },
    create: overrides,
  }), { pid: 42 });
  return { client, host };
}

describe("Runtime SDK v1", () => {
  it("negotiates capabilities, invokes handlers, and streams validated events", async () => {
    const { client, host } = harness();
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));
    await host.start();

    await expect(client.ready()).resolves.toEqual(["runtime.rpc", "runtime.events", "runtime.heartbeat"]);
    await expect(client.ping()).resolves.toBeUndefined();
    await expect(client.request("send", "hello", "/workspace", "conversation-1")).resolves.toBe("run-sdk-1");
    expect(events).toEqual(["run.started", "message.delta", "run.completed"]);
    expect(client.capabilities()).toEqual(["runtime.rpc", "runtime.events", "runtime.heartbeat"]);
  });

  it("returns structured unsupported-method and malformed-argument errors", async () => {
    const { client, host } = harness();
    await host.start();
    await expect(client.request("listConversations")).rejects.toMatchObject({
      protocolError: { code: "unsupported_method" },
    });
    await expect(client.request("send")).rejects.toMatchObject({
      protocolError: { code: "malformed_payload" },
    });
  });

  it("times out handlers and closes pending calls", async () => {
    vi.useFakeTimers();
    const { client, host } = harness(() => ({ send: () => new Promise(() => undefined) }));
    await host.start();
    const pending = client.request("send", "hello", undefined, "conversation-1");
    const timedOut = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(51);
    expect(await timedOut).toEqual(expect.objectContaining({ message: expect.stringContaining("timed out") }));
    client.close();
    await expect(client.request("listConversations")).rejects.toThrow("closed");
    vi.useRealTimers();
  });

  it("fails closed on malformed or incompatible server envelopes", async () => {
    const { client } = harness();
    const ready = client.ready();
    expect(() => client.accept({ kind: "runtime.ready", protocolVersion: 0, pid: 1, capabilities: [] }))
      .toThrow(RuntimeSdkError);
    await expect(ready).rejects.toMatchObject({ protocolError: { code: "incompatible_version" } });
  });

  it("validates public Agent manifests", () => {
    expect(() => defineAgent({
      manifest: { id: "Bad ID", name: "Bad", version: "latest", protocolVersion: 1, capabilities: [] },
      create: () => ({}),
    })).toThrow("id is invalid");
  });

  it("rejects missing required capabilities and invalid timeout configuration", async () => {
    expect(() => new RuntimeClient(() => undefined, { requestTimeoutMs: 0 })).toThrow("timeout must be positive");
    const client = new RuntimeClient(() => undefined);
    const ready = client.ready();
    expect(() => client.accept({
      kind: "runtime.ready",
      protocolVersion: runtimeProtocolVersion,
      pid: 1,
      capabilities: ["runtime.rpc"],
    })).toThrow(RuntimeSdkError);
    await expect(ready).rejects.toMatchObject({ protocolError: { code: "unsupported_capability" } });
  });

  it("propagates request and ping transport failures", async () => {
    const readyEnvelope = {
      kind: "runtime.ready" as const,
      protocolVersion: runtimeProtocolVersion,
      pid: 1,
      capabilities: [...runtimeCapabilities],
    };
    const requestClient = new RuntimeClient(() => Promise.reject("request transport failed"));
    requestClient.accept(readyEnvelope);
    await expect(requestClient.request("listConversations")).rejects.toThrow("request transport failed");

    const pingClient = new RuntimeClient(() => Promise.reject(new Error("ping transport failed")));
    pingClient.accept(readyEnvelope);
    await expect(pingClient.ping()).rejects.toThrow("ping transport failed");
  });

  it("times out pings and rejects pending work when closed", async () => {
    vi.useFakeTimers();
    const sent: RuntimeClientEnvelope[] = [];
    const client = new RuntimeClient((message) => { sent.push(message); }, { requestTimeoutMs: 20 });
    client.accept({ kind: "runtime.ready", protocolVersion: runtimeProtocolVersion, pid: 1, capabilities: [...runtimeCapabilities] });
    const ping = client.ping();
    const pingTimedOut = ping.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(21);
    expect(await pingTimedOut).toEqual(expect.objectContaining({ message: expect.stringContaining("ping timed out") }));

    const request = client.request("listConversations");
    const pendingPing = client.ping();
    await Promise.resolve();
    const requestClosed = request.catch((error: unknown) => error);
    const pingClosed = pendingPing.catch((error: unknown) => error);
    client.close("shutdown");
    const closedErrors = await Promise.all([requestClosed, pingClosed]);
    expect(closedErrors.every((error) => error instanceof Error && error.message === "shutdown")).toBe(true);
    client.close("ignored");
    expect(() => client.accept({ kind: "runtime.pong", protocolVersion: 1, id: "ignored" })).not.toThrow();
    expect(sent.some((message) => message.kind === "runtime.ping")).toBe(true);
    vi.useRealTimers();
  });

  it("enforces request IDs and supports event unsubscription and unknown replies", async () => {
    const client = new RuntimeClient(() => undefined, { id: () => "same-id" });
    client.accept({ kind: "runtime.ready", protocolVersion: 1, pid: 1, capabilities: [...runtimeCapabilities] });
    const listener = vi.fn();
    const unsubscribe = client.onEvent(listener);
    unsubscribe();
    client.accept({ kind: "runtime.event", protocolVersion: 1, event: { type: "runtime.status", status: "running" } });
    client.accept({ kind: "runtime.response", protocolVersion: 1, id: "unknown", result: true });
    client.accept({ kind: "runtime.pong", protocolVersion: 1, id: "unknown" });
    expect(listener).not.toHaveBeenCalled();

    const pending = client.request("listConversations");
    await expect(client.request("listConversations")).rejects.toThrow("unique");
    const closed = pending.catch((error: unknown) => error);
    client.close("closed for test");
    expect(await closed).toEqual(expect.objectContaining({ message: "closed for test" }));
  });

  it("validates every Agent manifest and host construction boundary", () => {
    const base = {
      id: "valid-agent",
      name: "Valid Agent",
      version: "1.0.0",
      protocolVersion: 1 as const,
      capabilities: ["runtime.rpc"],
    };
    expect(() => defineAgent({ manifest: { ...base, name: "" }, create: () => ({}) })).toThrow("name is invalid");
    expect(() => defineAgent({ manifest: { ...base, version: "1" }, create: () => ({}) })).toThrow("SemVer");
    expect(() => defineAgent({ manifest: { ...base, protocolVersion: 2 as 1 }, create: () => ({}) })).toThrow("protocolVersion");
    expect(() => defineAgent({ manifest: { ...base, capabilities: ["runtime.rpc", "runtime.rpc"] }, create: () => ({}) })).toThrow("capabilities are invalid");
    expect(() => defineAgent({ manifest: { ...base, capabilities: ["Bad Capability"] }, create: () => ({}) })).toThrow("capabilities are invalid");
    expect(() => defineAgent({ manifest: { ...base, capabilities: ["runtime.events"] }, create: () => ({}) })).toThrow("runtime.rpc");
    expect(() => defineAgent({ manifest: base, create: undefined as never })).toThrow("factory is required");

    const definition = defineAgent({ manifest: base, create: () => ({}) });
    expect(() => new RuntimeHost(() => undefined, definition, { pid: 0 })).toThrow("pid is invalid");
    expect(() => new RuntimeHost(() => undefined, definition, { capabilities: ["Invalid"] })).toThrow("capabilities are invalid");
    expect(defaultRuntimeCapabilities()).toEqual(runtimeCapabilities);
  });

  it("validates host lifecycle, malformed requests, events, and handler failures", async () => {
    const responses: RuntimeServerEnvelope[] = [];
    const definition = defineAgent({
      manifest: { id: "host-test", name: "Host Test", version: "1.0.0", protocolVersion: 1, capabilities: ["runtime.rpc"] },
      create: () => ({
        listConversations: () => { throw new Error("handler failed"); },
        reset: () => { throw new RuntimeSdkError({ code: "unsupported_method", message: "reset disabled" }); },
        getPermissionRuntime: () => { throw "string failure"; },
      }),
    });
    const host = new RuntimeHost((message) => { responses.push(message); }, definition, { pid: 7 });
    expect(host.manifest()).toEqual(definition.manifest);
    await expect(host.accept({ kind: "runtime.ping", protocolVersion: 1, id: "before" })).rejects.toThrow("not started");
    await expect(host.emit({ type: "runtime.status", status: "running" })).rejects.toThrow("not started");
    await host.start();
    await expect(host.start()).rejects.toThrow("already started");

    await host.accept({ kind: "runtime.request", protocolVersion: 1, id: "malformed", method: "send", args: [] });
    await host.accept({ kind: "future", id: "ignored" });
    await host.accept({ kind: "runtime.request", protocolVersion: 1, id: "error-1", method: "listConversations", args: [] });
    await host.accept({ kind: "runtime.request", protocolVersion: 1, id: "error-2", method: "reset", args: [] });
    await host.accept({ kind: "runtime.request", protocolVersion: 1, id: "error-3", method: "getPermissionRuntime", args: [] });
    await expect(host.emit({ type: "future.event" } as never)).rejects.toThrow("Malformed");

    expect(responses.filter((message) => message.kind === "runtime.response").map((message) => (
      message.kind === "runtime.response" ? message.error?.code : undefined
    ))).toEqual(["malformed_payload", "internal_error", "unsupported_method", "internal_error"]);
  });
});
