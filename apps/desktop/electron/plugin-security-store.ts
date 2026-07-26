import fs from "node:fs";
import path from "node:path";
import type { PluginManifest, PluginResourceType, PluginRiskTier } from "../src/contracts.js";

export type PluginSecurityRecord = {
  source: string;
  name: string;
  version: string;
  publisher?: string;
  integrity?: string;
  shasum?: string;
  provenance: "npm-registry" | "legacy";
  riskTier: PluginRiskTier;
  resources: PluginResourceType[];
  manifest: PluginManifest;
  installedAt?: string;
  enabled: boolean;
  projectOverrides: Record<string, boolean>;
};

type StoredPluginSecurity = {
  version: 1;
  records: PluginSecurityRecord[];
};

const sourcePattern = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z.+_-]*$/i;
const resourceTypes = new Set<PluginResourceType>(["extensions", "skills", "prompts", "themes"]);

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function cleanManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const result: PluginManifest = {};
  for (const resource of resourceTypes) {
    const entries = input[resource];
    if (!Array.isArray(entries)) continue;
    result[resource] = entries.filter((entry): entry is string => typeof entry === "string");
  }
  return result;
}

export class PluginSecurityStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "plugin-security.json");
  }

  list(): PluginSecurityRecord[] {
    return this.read().records.map((record) => ({
      ...record,
      resources: [...record.resources],
      manifest: cleanManifest(record.manifest),
      projectOverrides: { ...record.projectOverrides },
    }));
  }

  get(source: string): PluginSecurityRecord | undefined {
    return this.list().find((record) => record.source === source);
  }

  save(record: Omit<PluginSecurityRecord, "enabled" | "projectOverrides"> & Partial<Pick<PluginSecurityRecord, "enabled" | "projectOverrides">>): PluginSecurityRecord {
    if (!sourcePattern.test(record.source)) throw new Error("插件来源格式无效。");
    const current = this.read();
    const previous = current.records.find((entry) => entry.source === record.source);
    const next: PluginSecurityRecord = {
      ...record,
      resources: record.resources.filter((entry) => resourceTypes.has(entry)),
      manifest: cleanManifest(record.manifest),
      enabled: record.enabled ?? previous?.enabled ?? true,
      projectOverrides: record.projectOverrides ?? previous?.projectOverrides ?? {},
    };
    this.write({ version: 1, records: [...current.records.filter((entry) => entry.source !== record.source), next] });
    return next;
  }

  remove(source: string): void {
    const current = this.read();
    const records = current.records.filter((record) => record.source !== source);
    if (records.length !== current.records.length) this.write({ version: 1, records });
  }

  setEnabled(source: string, enabled: boolean, cwd?: string, scope: "user" | "project" = "user"): PluginSecurityRecord {
    if (!sourcePattern.test(source)) throw new Error("插件来源格式无效。");
    const current = this.read();
    const existing = current.records.find((record) => record.source === source) ?? this.legacyRecord(source);
    const next = scope === "project" && cwd
      ? { ...existing, projectOverrides: { ...existing.projectOverrides, [canonicalPath(cwd)]: enabled } }
      : { ...existing, enabled };
    this.write({ version: 1, records: [...current.records.filter((record) => record.source !== source), next] });
    return next;
  }

  isEnabled(source: string, cwd?: string): boolean {
    const record = this.get(source);
    if (!record) return true;
    if (cwd) {
      const override = record.projectOverrides[canonicalPath(cwd)];
      if (typeof override === "boolean") return record.enabled && override;
    }
    return record.enabled;
  }

  private legacyRecord(source: string): PluginSecurityRecord {
    const spec = source.slice(4);
    const separator = spec.lastIndexOf("@");
    return {
      source,
      name: separator > 0 ? spec.slice(0, separator) : spec,
      version: separator > 0 ? spec.slice(separator + 1) : "unknown",
      provenance: "legacy",
      riskTier: "high",
      resources: [],
      manifest: {},
      enabled: true,
      projectOverrides: {},
    };
  }

  private read(): StoredPluginSecurity {
    try {
      if (!fs.existsSync(this.filePath)) return { version: 1, records: [] };
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      if (value.version !== 1 || !Array.isArray(value.records)) return { version: 1, records: [] };
      const records = value.records.flatMap((entry): PluginSecurityRecord[] => {
        if (!entry || typeof entry !== "object") return [];
        const input = entry as Record<string, unknown>;
        if (typeof input.source !== "string" || !sourcePattern.test(input.source)) return [];
        const legacy = this.legacyRecord(input.source);
        const riskTier = input.riskTier === "low" || input.riskTier === "medium" || input.riskTier === "high" || input.riskTier === "blocked"
          ? input.riskTier
          : legacy.riskTier;
        const projectOverrides: Record<string, boolean> = {};
        if (input.projectOverrides && typeof input.projectOverrides === "object") {
          for (const [project, enabled] of Object.entries(input.projectOverrides as Record<string, unknown>)) {
            if (path.isAbsolute(project) && typeof enabled === "boolean") projectOverrides[canonicalPath(project)] = enabled;
          }
        }
        return [{
          ...legacy,
          name: typeof input.name === "string" ? input.name : legacy.name,
          version: typeof input.version === "string" ? input.version : legacy.version,
          publisher: typeof input.publisher === "string" ? input.publisher : undefined,
          integrity: typeof input.integrity === "string" ? input.integrity : undefined,
          shasum: typeof input.shasum === "string" ? input.shasum : undefined,
          provenance: input.provenance === "npm-registry" ? "npm-registry" : "legacy",
          riskTier,
          resources: Array.isArray(input.resources)
            ? input.resources.filter((resource): resource is PluginResourceType => resourceTypes.has(resource as PluginResourceType))
            : [],
          manifest: cleanManifest(input.manifest),
          installedAt: typeof input.installedAt === "string" ? input.installedAt : undefined,
          enabled: typeof input.enabled === "boolean" ? input.enabled : true,
          projectOverrides,
        }];
      });
      return { version: 1, records };
    } catch {
      return { version: 1, records: [] };
    }
  }

  private write(value: StoredPluginSecurity): void {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
