import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlTraceExporter, OtlpHttpTraceExporter, otlpTracePayload } from "./trace-exporters.js";
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
});
