import type { TraceCaptureContent } from "../src/contracts.js";

export type TraceAttributeValue = string | number | boolean | string[] | number[] | boolean[];

export type TraceSpanEvent = {
  name: string;
  timeUnixMs: number;
  attributes?: Record<string, TraceAttributeValue>;
};

export type TraceSpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "client";
  startTimeUnixMs: number;
  endTimeUnixMs: number;
  attributes: Record<string, TraceAttributeValue>;
  events: TraceSpanEvent[];
  status: { code: "unset" | "ok" | "error"; message?: string };
};

export type TraceRecordContext = {
  prompt?: string;
  captureContent: TraceCaptureContent;
};

export interface TraceSpanSink {
  add(span: TraceSpanRecord): void;
}
