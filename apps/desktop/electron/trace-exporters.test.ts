import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositeTraceExporter, JsonlTraceExporter, OtlpHttpTraceExporter, otlpTracePayload } from "./trace-exporters.js";
import type { ResolvedOtlpTraceExporter } from "./observability-store.js";
import type { TraceSpanRecord } from "./trace-model.js";

const directories: string[] = [];

function span(): TraceSpanRecord {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    name: "agent.run",
    kind: "internal",
    startTimeUnixMs: 100,
    endTimeUnixMs: 200,
    attributes: { "service.test": true, count: 2, labels: ["one", "two"] },
    events: [{ name: "exception", timeUnixMs: 150, attributes: { "exception.message": "failed" } }],
    status: { code: "ok" },
  };
}

function settings(name = "OTLP"): ResolvedOtlpTraceExporter {
  return { id: "one", name, endpoint: "https://example.com/otel", enabled: true, headers: {} };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("trace exporters", () => {
  it("encodes spans using the OTLP HTTP JSON shape", () => {
    const payload = otlpTracePayload("pi-test", [span()]) as { resourceSpans: Array<{ resource: { attributes: Array<{ key: string }> }; scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> };
    expect(payload.resourceSpans[0].resource.attributes.some((attribute) => attribute.key === "service.name")).toBe(true);
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      startTimeUnixNano: "100000000",
      endTimeUnixNano: "200000000",
      status: { code: 1 },
    });
  });

  it("writes one recoverable JSON object per local trace line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-traces-"));
    directories.push(root);
    const exporter = new JsonlTraceExporter(root);
    exporter.add(span());
    const records = fs.readFileSync(exporter.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: "agent.run", traceId: span().traceId });
  });

  it("sends batches to the normalized endpoint with configured headers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const statuses: unknown[] = [];
    const exporter = new OtlpHttpTraceExporter("pi-test", {
      id: "one",
      name: "Langfuse",
      endpoint: "https://example.com/api/public/otel",
      enabled: true,
      headers: { Authorization: "Basic secret" },
    }, (status) => statuses.push(status), fetcher);
    exporter.add(span());
    await exporter.flush();
    await exporter.shutdown();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://example.com/api/public/otel/v1/traces");
    expect(requests[0].init?.headers).toMatchObject({ Authorization: "Basic secret", "content-type": "application/json" });
    expect(JSON.parse(String(requests[0].init?.body)).resourceSpans).toHaveLength(1);
    expect(statuses).toContainEqual(expect.objectContaining({ queuedSpanCount: 0 }));
  });

  it("encodes numeric, parent, client-kind, status and endpoint variants", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const exporter = new OtlpHttpTraceExporter("pi-test", {
      id: "one",
      name: "OTLP",
      endpoint: "https://example.com/v1/traces/",
      enabled: true,
      headers: {},
    }, () => {}, fetcher);
    exporter.add({
      ...span(),
      parentSpanId: "ffffffffffffffff",
      kind: "client",
      attributes: { score: 1.5, flags: [true, false], retries: [1, 2] },
      events: [{ name: "note", timeUnixMs: 150 }],
      status: { code: "error", message: "boom" },
    });
    exporter.add({ ...span(), spanId: "aaaaaaaaaaaaaaaa", status: { code: "unset" } });
    await exporter.flush();
    await exporter.shutdown();

    expect(requests).toEqual(["https://example.com/v1/traces"]);
    const payload = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    const [first, second] = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(first).toMatchObject({ parentSpanId: "ffffffffffffffff", kind: 3, status: { code: 2, message: "boom" } });
    expect(first.events[0].attributes).toEqual([]);
    expect(first.attributes).toEqual(expect.arrayContaining([
      { key: "score", value: { doubleValue: 1.5 } },
      { key: "flags", value: { arrayValue: { values: [{ boolValue: true }, { boolValue: false }] } } },
      { key: "retries", value: { arrayValue: { values: [{ intValue: "1" }, { intValue: "2" }] } } },
    ]));
    expect(second.status).toEqual({ code: 0 });
  });

  it("returns the in-flight flush to concurrent callers and no-ops on an empty queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => {
      await gate;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const exporter = new OtlpHttpTraceExporter("pi-test", settings(), () => {}, fetcher);
    await exporter.flush();
    exporter.add(span());
    const first = exporter.flush();
    const second = exporter.flush();
    release();
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requeues the batch and reports the error when the export fails", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 500 })) as typeof fetch;
    const statuses: Array<Record<string, unknown>> = [];
    const exporter = new OtlpHttpTraceExporter("pi-test", settings("Langfuse"), (status) => statuses.push(status), fetcher);
    exporter.add(span());
    await exporter.flush();
    expect(exporter.queued()).toBe(1);
    expect(statuses).toContainEqual(expect.objectContaining({ lastError: "Langfuse: HTTP 500", queuedSpanCount: 1 }));
    await exporter.shutdown();
    expect(exporter.queued()).toBe(1);
  });

  it("labels aborts as timeouts and stringifies non-error rejections", async () => {
    const aborting = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch;
    const statuses: Array<Record<string, unknown>> = [];
    const exporter = new OtlpHttpTraceExporter("pi-test", settings("OTLP"), (status) => statuses.push(status), aborting);
    exporter.add(span());
    await exporter.flush();
    expect(statuses).toContainEqual(expect.objectContaining({ lastError: "OTLP: 请求超时" }));

    const failing = vi.fn(async () => Promise.reject("plain failure")) as typeof fetch;
    const other = new OtlpHttpTraceExporter("pi-test", settings("OTLP"), (status) => statuses.push(status), failing);
    other.add(span());
    await other.flush();
    expect(statuses).toContainEqual(expect.objectContaining({ lastError: "OTLP: plain failure" }));
  });

  it("drops the oldest spans and reports once the queue overflows", () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const statuses: Array<Record<string, unknown>> = [];
    const exporter = new OtlpHttpTraceExporter("pi-test", settings("Langfuse"), (status) => statuses.push(status), fetcher);
    for (let index = 0; index < 2200; index += 1) exporter.add(span());
    expect(exporter.queued()).toBe(2048);
    expect(statuses).toContainEqual(expect.objectContaining({ lastError: "Langfuse 的 Trace 队列已满，最早的 Span 已丢弃。" }));
  });

  it("ignores spans added after disposal", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 200 })) as typeof fetch;
    const exporter = new OtlpHttpTraceExporter("pi-test", settings(), () => {}, fetcher);
    await exporter.shutdown();
    exporter.add(span());
    expect(exporter.queued()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("composite exporter isolates failures and settles every child", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const received: TraceSpanRecord[] = [];
    const calls: string[] = [];
    const broken = {
      add: () => { throw new Error("broken sink"); },
      flush: async () => { calls.push("broken.flush"); throw new Error("flush failed"); },
      shutdown: async () => { calls.push("broken.shutdown"); },
    };
    const healthy = {
      add: (span: TraceSpanRecord) => received.push(span),
      flush: async () => { calls.push("healthy.flush"); },
      shutdown: async () => { calls.push("healthy.shutdown"); },
    };
    const composite = new CompositeTraceExporter([broken, healthy]);
    composite.add(span());
    await composite.flush();
    await composite.shutdown();

    expect(received).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("Trace exporter failed:", "broken sink");
    expect(calls).toEqual(expect.arrayContaining(["broken.flush", "healthy.flush", "broken.shutdown", "healthy.shutdown"]));
  });
});
