import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  },
}));

import { ObservabilityStore, type ObservabilitySafeStorage } from "./observability-store.js";

const directories: string[] = [];
const secureStorage: ObservabilitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, ""),
};

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-settings-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("ObservabilityStore", () => {
  it("enables safe local metadata traces by default", () => {
    expect(new ObservabilityStore(directory(), secureStorage).get()).toEqual({
      enabled: true,
      serviceName: "pi-forge",
      captureContent: "metadata",
      localFileEnabled: true,
      exporters: [],
    });
  });

  it("encrypts exporter headers and never exposes their values through public settings", () => {
    const root = directory();
    const store = new ObservabilityStore(root, secureStorage);
    const saved = store.save({
      enabled: true,
      serviceName: "desktop-agent",
      captureContent: "full",
      localFileEnabled: false,
      exporters: [{
        name: "Langfuse",
        endpoint: "https://cloud.langfuse.com/api/public/otel/",
        enabled: true,
        headers: { Authorization: "Basic secret" },
      }],
    });

    expect(saved.exporters[0]).toMatchObject({ name: "Langfuse", hasHeaders: true });
    expect(JSON.stringify(saved)).not.toContain("Basic secret");
    expect(fs.readFileSync(path.join(root, "observability-settings.json"), "utf8")).not.toContain("Basic secret");
    expect(store.resolve().exporters[0].headers).toEqual({ Authorization: "Basic secret" });
  });

  it("preserves encrypted headers when an existing exporter is saved with headers omitted", () => {
    const store = new ObservabilityStore(directory(), secureStorage);
    const first = store.save({
      enabled: true,
      serviceName: "pi-forge",
      captureContent: "metadata",
      localFileEnabled: true,
      exporters: [{ name: "Primary", endpoint: "http://localhost:4318", enabled: true, headers: { "x-api-key": "secret" } }],
    });
    store.save({
      enabled: true,
      serviceName: "pi-forge",
      captureContent: "metadata",
      localFileEnabled: true,
      exporters: [{ id: first.exporters[0].id, name: "Renamed", endpoint: "http://localhost:4318", enabled: true }],
    });

    expect(store.resolve().exporters[0]).toMatchObject({ name: "Renamed", headers: { "x-api-key": "secret" } });
  });

  it("rejects invalid endpoints and header injection", () => {
    const store = new ObservabilityStore(directory(), secureStorage);
    const base = {
      enabled: true,
      serviceName: "pi-forge",
      captureContent: "none" as const,
      localFileEnabled: true,
    };
    expect(() => store.save({ ...base, exporters: [{ name: "bad", endpoint: "file:///tmp/traces", enabled: true }] })).toThrow("仅支持 HTTP 或 HTTPS");
    expect(() => store.save({ ...base, exporters: [{ name: "bad", endpoint: "https://example.com", enabled: true, headers: { Authorization: "ok\r\nInjected: yes" } }] })).toThrow("请求头值无效");
  });
});
