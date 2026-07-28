import path from "node:path";
import type { AgentEvent, ObservabilitySettings, SaveObservabilitySettings, TraceRuntimeStatus } from "../src/contracts.js";
import { ObservabilityStore } from "./observability-store.js";
import { AgentTraceAggregator } from "./trace-aggregator.js";
import { CompositeTraceExporter, JsonlTraceExporter, OtlpHttpTraceExporter } from "./trace-exporters.js";
import type { TraceCaptureContent } from "../src/contracts.js";

export class ObservabilityService {
  private aggregator?: AgentTraceAggregator;
  private exporter?: CompositeTraceExporter;
  private otlpExporters: OtlpHttpTraceExporter[] = [];
  private readonly traceDirectory: string;
  private captureContent: TraceCaptureContent = "none";
  private statusValue: TraceRuntimeStatus = { enabled: false, queuedSpanCount: 0 };

  constructor(private readonly store: ObservabilityStore, userDataPath: string) {
    this.traceDirectory = path.join(userDataPath, "traces");
    this.configure();
  }

  getSettings(): ObservabilitySettings {
    return this.store.get();
  }

  saveSettings(input: SaveObservabilitySettings): ObservabilitySettings {
    const saved = this.store.save(input);
    this.aggregator?.finishOpenRuns("Trace configuration changed during an active run");
    void this.exporter?.shutdown();
    this.configure();
    return saved;
  }

  status(): TraceRuntimeStatus {
    return {
      ...this.statusValue,
      queuedSpanCount: this.otlpExporters.reduce((total, exporter) => total + exporter.queued(), 0),
    };
  }

  record(event: AgentEvent, prompt?: string): void {
    this.aggregator?.record(event, event.type === "run.started" ? {
      prompt,
      captureContent: this.captureContent,
    } : undefined);
  }

  async flush(): Promise<void> {
    await this.exporter?.flush();
  }

  async shutdown(): Promise<void> {
    this.aggregator?.finishOpenRuns();
    await this.exporter?.shutdown();
  }

  private configure(): void {
    const settings = this.store.resolve();
    this.captureContent = settings.captureContent;
    this.statusValue = { enabled: settings.enabled, queuedSpanCount: 0 };
    this.otlpExporters = [];
    if (!settings.enabled) {
      this.aggregator = undefined;
      this.exporter = undefined;
      return;
    }

    const exporters: Array<JsonlTraceExporter | OtlpHttpTraceExporter> = [];
    if (settings.localFileEnabled) {
      const local = new JsonlTraceExporter(this.traceDirectory);
      exporters.push(local);
      this.statusValue.localTracePath = local.filePath;
    }
    for (const exporterSettings of settings.exporters.filter((candidate) => candidate.enabled)) {
      const exporter = new OtlpHttpTraceExporter(settings.serviceName, exporterSettings, (patch) => {
        this.statusValue = { ...this.statusValue, ...patch };
      });
      this.otlpExporters.push(exporter);
      exporters.push(exporter);
    }
    this.exporter = new CompositeTraceExporter(exporters);
    this.aggregator = new AgentTraceAggregator(this.exporter);
  }
}
