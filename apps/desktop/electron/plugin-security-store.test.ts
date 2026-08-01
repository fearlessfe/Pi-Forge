import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginResourceType } from "../src/contracts.js";
import { PluginSecurityStore } from "./plugin-security-store.js";

const cleanup: string[] = [];

function directory(label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `pi-plugin-security-${label}-`));
  cleanup.push(target);
  return target;
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("PluginSecurityStore", () => {
  it("preserves install trust while applying user and project enablement", () => {
    const userData = directory("lifecycle");
    const project = directory("project");
    const missingProject = path.join(project, "not-created");
    const store = new PluginSecurityStore(userData);
    const source = "npm:@demo/pi-tools@1.2.3";

    expect(store.get(source)).toBeUndefined();
    expect(store.isEnabled(source, project)).toBe(true);
    expect(() => store.save({
      source: "file:unsafe",
      name: "unsafe",
      version: "1",
      provenance: "legacy",
      riskTier: "high",
      resources: [],
      manifest: {},
    })).toThrow("来源格式无效");

    const saved = store.save({
      source,
      name: "@demo/pi-tools",
      version: "1.2.3",
      publisher: "demo",
      provenance: "npm-registry",
      riskTier: "medium",
      resources: ["skills", "prompts", "invalid" as PluginResourceType],
      manifest: {
        skills: ["./skills", 42 as unknown as string],
        prompts: ["./prompts"],
      },
      securityScan: {
        scannerVersion: 1,
        status: "review",
        scannedAt: "2026-07-31T00:00:00.000Z",
        scannedFiles: 2,
        scannedBytes: 120,
        skippedFiles: 0,
        truncated: false,
        findings: [{
          ruleId: "prompt-ignore-instructions",
          category: "prompt-injection",
          severity: "high",
          confidence: "medium",
          path: "skills/review/SKILL.md",
          line: 3,
          message: "需要审核",
          remediation: "删除覆盖指令",
        }],
      },
      enabled: false,
    });
    expect(saved).toMatchObject({
      enabled: false,
      resources: ["skills", "prompts"],
      manifest: { skills: ["./skills"], prompts: ["./prompts"] },
      securityScan: expect.objectContaining({ status: "review", scannedFiles: 2 }),
      projectOverrides: {},
    });
    expect(store.isEnabled(source, project)).toBe(false);

    store.setEnabled(source, true);
    store.setEnabled(source, false, project, "project");
    expect(store.isEnabled(source)).toBe(true);
    expect(store.isEnabled(source, project)).toBe(false);
    expect(store.isEnabled(source, missingProject)).toBe(true);

    const updated = store.save({
      source,
      name: "@demo/pi-tools",
      version: "1.2.4",
      provenance: "npm-registry",
      riskTier: "low",
      resources: ["themes"],
      manifest: { themes: ["./themes"] },
    });
    expect(updated.enabled).toBe(true);
    expect(updated.projectOverrides).toEqual({ [fs.realpathSync(project)]: false });
    expect(updated.securityScan).toBeUndefined();

    store.remove("npm:missing@1.0.0");
    store.remove(source);
    expect(store.list()).toEqual([]);
  });

  it("creates conservative legacy records and validates toggle sources", () => {
    const store = new PluginSecurityStore(directory("legacy"));
    expect(() => store.setEnabled("unsafe", false)).toThrow("来源格式无效");

    const legacy = store.setEnabled("npm:legacy-plugin@2.0.0", false);
    expect(legacy).toMatchObject({
      name: "legacy-plugin",
      version: "2.0.0",
      provenance: "legacy",
      riskTier: "high",
      enabled: false,
    });
    expect(store.isEnabled(legacy.source)).toBe(false);
  });

  it("fails closed when persisted scan findings block a plugin", () => {
    const store = new PluginSecurityStore(directory("blocked"));
    const source = "npm:pi-blocked@1.0.0";
    const saved = store.save({
      source,
      name: "pi-blocked",
      version: "1.0.0",
      provenance: "npm-registry",
      riskTier: "high",
      resources: ["prompts"],
      manifest: { prompts: ["./prompt.md"] },
      securityScan: {
        scannerVersion: 1,
        status: "clean",
        scannedAt: "2026-07-31T00:00:00.000Z",
        scannedFiles: 1,
        scannedBytes: 80,
        skippedFiles: 0,
        truncated: false,
        findings: [{
          ruleId: "secret-service-token",
          category: "secrets",
          severity: "critical",
          confidence: "high",
          path: "prompt.md",
          line: 1,
          message: "存在凭据",
          remediation: "移除凭据",
        }],
      },
      enabled: true,
    });

    expect(saved.securityScan?.status).toBe("blocked");
    expect(saved.enabled).toBe(false);
    expect(() => store.setEnabled(source, true)).toThrow("阻止启用");
  });

  it("sanitizes partially corrupted persisted records without losing valid trust data", () => {
    const userData = directory("corrupted");
    const project = directory("corrupted-project");
    const filePath = path.join(userData, "plugin-security.json");
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      records: [
        null,
        { source: "invalid" },
        {
          source: "npm:pi-safe@1.0.0",
          name: 7,
          version: null,
          publisher: "alice",
          integrity: 9,
          shasum: "abc",
          provenance: "npm-registry",
          riskTier: "blocked",
          resources: ["extensions", "invalid"],
          manifest: { extensions: ["./extension.ts", 5], skills: "invalid" },
          installedAt: "2026-07-27T00:00:00.000Z",
          enabled: false,
          projectOverrides: {
            [project]: true,
            relative: false,
            [path.join(project, "other")]: "yes",
          },
        },
        {
          source: "npm:@scope/minimal@beta",
          riskTier: "unexpected",
          resources: "invalid",
          manifest: null,
          projectOverrides: null,
        },
      ],
    }));

    const store = new PluginSecurityStore(userData);
    expect(store.list()).toEqual([
      expect.objectContaining({
        source: "npm:pi-safe@1.0.0",
        name: "pi-safe",
        version: "1.0.0",
        publisher: "alice",
        integrity: undefined,
        shasum: "abc",
        riskTier: "blocked",
        resources: ["extensions"],
        manifest: { extensions: ["./extension.ts"] },
        enabled: false,
        projectOverrides: { [fs.realpathSync(project)]: true },
      }),
      expect.objectContaining({
        source: "npm:@scope/minimal@beta",
        name: "@scope/minimal",
        version: "beta",
        provenance: "legacy",
        riskTier: "high",
        resources: [],
        manifest: {},
        enabled: true,
      }),
    ]);

    fs.writeFileSync(filePath, JSON.stringify({ version: 2, records: [] }));
    expect(store.list()).toEqual([]);
    fs.writeFileSync(filePath, "not-json");
    expect(store.list()).toEqual([]);
  });
});
