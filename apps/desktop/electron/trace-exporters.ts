import fs from "node:fs";
import path from "node:path";
import type { TraceRuntimeStatus } from "../src/contracts.js";
import type { ResolvedOtlpTraceExporter } from "./observability-store.js";
import type { TraceAttributeValue, TraceSpanRecord, TraceSpanSink } from "./trace-model.js";

type ExportStatusListener = (patch: Partial<TraceRuntimeStatus>) => void;
type FetchLike = typeof fetch;

function anyValue(value: TraceAttributeValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { arrayValue: { values: value.map((entry) => anyValue(entry)) } };
}

function attributes(values: Record<string, TraceAttributeValue>): Array<Record<string, unknown>> {
  return Object.entries(values).map(([key, value]) => ({ key, value: anyValue(value) }));
}

function unixNano(milliseconds: number): string {
  return (BigInt(Math.trunc(milliseconds)) * 1_000_000n).toString();
}

function otlpSpan(span: TraceSpanRecord): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.kind === "client" ? 3 : 1,
    startTimeUnixNano: unixNano(span.startTimeUnixMs),
    endTimeUnixNano: unixNano(span.endTimeUnixMs),
    attributes: attributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: unixNano(event.timeUnixMs),
      attributes: attributes(event.attributes ?? {}),
    })),
    status: {
      code: span.status.code === "ok" ? 1 : span.status.code === "error" ? 2 : 0,
      ...(span.status.message ? { message: span.status.message } : {}),
    },
  };
}

export function otlpTracePayload(serviceName: string, spans: TraceSpanRecord[]): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: {
        attributes: attributes({
          "service.name": serviceName,
          "service.version": process.env.npm_package_version ?? "0.1.0",
          "telemetry.sdk.name": "pi-forge",
          "telemetry.sdk.language": "nodejs",
        }),
      },
      scopeSpans: [{
        scope: { name: "dev.piforge.agent", version: "1" },
        spans: spans.map(otlpSpan),
      }],
    }],
  };
}

function traceEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/$/, "");
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}

export class JsonlTraceExporter implements TraceSpanSink {
  readonly filePath: string;

  constructor(directory: string) {
    const date = new Date().toISOString().slice(0, 10);
    this.filePath = path.join(directory, `trace-${date}.jsonl`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  add(span: TraceSpanRecord): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(span)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export class OtlpHttpTraceExporter implements TraceSpanSink {
  private queue: TraceSpanRecord[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly serviceName: string,
    private readonly settings: ResolvedOtlpTraceExporter,
    private readonly onStatus: ExportStatusListener,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  add(span: TraceSpanRecord): void {
    if (this.disposed) return;
    this.queue.push(span);
    if (this.queue.length > 2048) {
      this.queue.splice(0, this.queue.length - 2048);
      this.onStatus({ lastError: `${this.settings.name} 的 Trace 队列已满，最早的 Span 已丢弃。` });
    }
    this.onStatus({ queuedSpanCount: this.queue.length });
    if (this.queue.length >= 128) void this.flush();
    else this.schedule();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0 || this.disposed) return;
    this.flushing = this.flushBatches().finally(() => {
      this.flushing = undefined;
      if (this.queue.length > 0 && !this.disposed) this.schedule(5_000);
    });
    return this.flushing;
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    this.disposed = true;
  }

  queued(): number {
    return this.queue.length;
  }

  private schedule(delay = 1_000): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => void this.flush(), delay);
    this.timer.unref?.();
  }

  private async flushBatches(): Promise<void> {
    while (this.queue.length > 0 && !this.disposed) {
      const batch = this.queue.splice(0, 128);
      this.onStatus({ queuedSpanCount: this.queue.length });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await this.fetcher(traceEndpoint(this.settings.endpoint), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...this.settings.headers,
          },
          body: JSON.stringify(otlpTracePayload(this.serviceName, batch)),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.onStatus({ lastExportAt: new Date().toISOString(), lastError: undefined, queuedSpanCount: this.queue.length });
      } catch (error) {
        this.queue.unshift(...batch);
        const message = error instanceof Error && error.name === "AbortError" ? "请求超时" : error instanceof Error ? error.message : String(error);
        this.onStatus({ lastError: `${this.settings.name}: ${message}`, queuedSpanCount: this.queue.length });
        return;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

export class CompositeTraceExporter implements TraceSpanSink {
  constructor(private readonly exporters: Array<TraceSpanSink & { flush(): Promise<void>; shutdown(): Promise<void> }>) {}

  add(span: TraceSpanRecord): void {
    for (const exporter of this.exporters) {
      try {
        exporter.add(span);
      } catch (error) {
        // Observability must never interrupt an agent run.
        console.warn("Trace exporter failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.flush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.exporters.map((exporter) => exporter.shutdown()));
  }
}
