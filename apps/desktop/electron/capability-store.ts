import fs from "node:fs";
import path from "node:path";
import type { CapabilitySettings, PackageCapabilityProvider, SubagentProvider } from "../src/contracts.js";

const defaults: CapabilitySettings = {
  subagent: { kind: "builtin" },
  memory: { kind: "none" },
  learning: { kind: "none" },
  subagentHistory: [],
  memoryHistory: [],
  learningHistory: [],
};

const toolNamePattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const packageSourcePattern = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9A-Za-z][0-9A-Za-z.+_-]*$/i;

export class CapabilityStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "capabilities.json");
  }

  get(): CapabilitySettings {
    try {
      if (!fs.existsSync(this.filePath)) return defaults;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      return {
        subagent: this.validateSubagent(parsed.subagent),
        memory: this.validatePackageProvider(parsed.memory),
        learning: this.validatePackageProvider(parsed.learning),
        subagentHistory: this.validateHistory(parsed.subagentHistory, (value) => this.validateSubagent(value), "builtin"),
        memoryHistory: this.validateHistory(parsed.memoryHistory, (value) => this.validatePackageProvider(value), "none"),
        learningHistory: this.validateHistory(parsed.learningHistory, (value) => this.validatePackageProvider(value), "none"),
      };
    } catch {
      return defaults;
    }
  }

  saveSubagent(provider: SubagentProvider): CapabilitySettings {
    if (provider.kind === "plugin" && (!toolNamePattern.test(provider.toolName) || !packageSourcePattern.test(provider.source))) {
      throw new Error("插件工具名格式无效。");
    }
    const current = this.get();
    const validated = this.validateSubagent(provider);
    const next: CapabilitySettings = {
      ...current,
      subagent: validated,
      subagentHistory: this.remember(current.subagentHistory, current.subagent, validated),
    };
    this.write(next);
    return next;
  }

  savePackageCapability(slot: "memory" | "learning", provider: PackageCapabilityProvider): CapabilitySettings {
    if (provider.kind === "plugin" && !packageSourcePattern.test(provider.source)) {
      throw new Error("插件来源格式无效。");
    }
    const current = this.get();
    const validated = this.validatePackageProvider(provider);
    const historyKey = slot === "memory" ? "memoryHistory" : "learningHistory";
    const next: CapabilitySettings = {
      ...current,
      [slot]: validated,
      [historyKey]: this.remember(current[historyKey], current[slot], validated),
    };
    this.write(next);
    return next;
  }

  private write(next: CapabilitySettings): void {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  private validateSubagent(value: unknown): SubagentProvider {
    if (!value || typeof value !== "object") return defaults.subagent;
    const input = value as Record<string, unknown>;
    if (input.kind === "builtin") return { kind: "builtin" };
    if (
      input.kind === "plugin"
      && typeof input.toolName === "string"
      && typeof input.source === "string"
      && toolNamePattern.test(input.toolName)
      && packageSourcePattern.test(input.source)
    ) {
      return { kind: "plugin", source: input.source, toolName: input.toolName };
    }
    return defaults.subagent;
  }

  private validatePackageProvider(value: unknown): PackageCapabilityProvider {
    if (!value || typeof value !== "object") return { kind: "none" };
    const input = value as Record<string, unknown>;
    if (input.kind === "none") return { kind: "none" };
    if (input.kind === "plugin" && typeof input.source === "string" && packageSourcePattern.test(input.source)) {
      return { kind: "plugin", source: input.source };
    }
    return { kind: "none" };
  }

  private validateHistory<T extends { kind: string }>(
    value: unknown,
    validate: (entry: unknown) => T,
    emptyKind: string,
  ): T[] {
    if (!Array.isArray(value)) return [];
    return value.map(validate).filter((entry) => entry.kind !== emptyKind).slice(0, 12);
  }

  private remember<T extends { kind: string }>(history: T[], previous: T, next: T): T[] {
    const candidates = [previous, next, ...history].filter((entry) => entry.kind === "plugin");
    const seen = new Set<string>();
    return candidates.filter((entry) => {
      const key = JSON.stringify(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 12);
  }
}
