import { Buffer } from "node:buffer";
import { countTokens as countAnthropicTokens } from "@anthropic-ai/tokenizer";
import { countTokens as countO200kTokens } from "gpt-tokenizer";
import { countTokens as countCl100kTokens } from "gpt-tokenizer/encoding/cl100k_base";
import type {
  ContextBudgetCategory,
  ContextBudgetEstimator,
  ContextBudgetItem,
  ContextBudgetReport,
} from "../src/contracts.js";

export type ContextBudgetResource = {
  category: ContextBudgetCategory;
  name: string;
  source: string;
  scope: ContextBudgetItem["scope"];
  enabled: boolean;
  disableSupported: boolean;
  baselineText?: string;
  onDemandText?: string;
  estimateStatus?: ContextBudgetItem["estimateStatus"];
};

export const contextBudgetCategories: ContextBudgetCategory[] = [
  "systemPrompt",
  "agents",
  "skills",
  "prompts",
  "extensions",
  "mcpSchemas",
];

export type ContextTokenEstimator = {
  metadata: ContextBudgetEstimator;
  count(text: string): number;
};

/**
 * Deterministic, model-independent approximation used throughout the report.
 * UTF-8 bytes are used instead of JavaScript character count so CJK and emoji
 * do not receive the same weight as one-byte ASCII. The result is intentionally
 * an explainable estimate rather than a provider-specific tokenizer result.
 */
export function estimateContextTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

function normalizedModelFamily(provider: string, model: string): "anthropic" | "openai" | "fallback" {
  const providerId = provider.toLowerCase();
  const modelId = model.toLowerCase();
  if (providerId.includes("anthropic") || modelId.startsWith("claude")) return "anthropic";
  if (
    providerId === "openai"
    || providerId === "openai-codex"
    || providerId === "azure-openai-responses"
    || providerId.startsWith("openai-")
    || /^(?:gpt|o[1-9]|codex)/.test(modelId)
  ) return "openai";
  return "fallback";
}

export function createContextTokenEstimator(
  provider = "unknown",
  model = "unknown",
): ContextTokenEstimator {
  const family = normalizedModelFamily(provider, model);
  if (family === "anthropic") {
    return {
      metadata: { id: "anthropic-tokenizer-v1", kind: "model-tokenizer", provider, model, tokenizer: "@anthropic-ai/tokenizer", local: true },
      count: (text) => text ? countAnthropicTokens(text) : 0,
    };
  }
  if (family === "openai") {
    const usesO200k = /^(?:gpt-(?:4o|4\.1|4\.5|5)|o[1-9]|codex)/i.test(model);
    return {
      metadata: {
        id: usesO200k ? "gpt-tokenizer-o200k-v1" : "gpt-tokenizer-cl100k-v1",
        kind: "model-tokenizer",
        provider,
        model,
        tokenizer: usesO200k ? "o200k_base" : "cl100k_base",
        local: true,
      },
      count: usesO200k ? countO200kTokens : countCl100kTokens,
    };
  }
  return {
    metadata: { id: "utf8-bytes-v1", kind: "fallback", provider, model, tokenizer: "UTF-8 bytes / 4", local: true, bytesPerToken: 4 },
    count: estimateContextTokens,
  };
}

function sum(items: ContextBudgetItem[], select: (item: ContextBudgetItem) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

export function stableContextValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContextValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableContextValue(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function buildContextBudgetReport(
  cwd: string,
  resources: ContextBudgetResource[],
  estimator: ContextTokenEstimator = createContextTokenEstimator("unknown", "unknown"),
): ContextBudgetReport {
  const ordered = [...resources].sort((left, right) => (
    contextBudgetCategories.indexOf(left.category) - contextBudgetCategories.indexOf(right.category)
    || left.name.localeCompare(right.name)
    || left.scope.localeCompare(right.scope)
    || left.source.localeCompare(right.source)
  ));
  const ids = new Map<string, number>();
  const items: ContextBudgetItem[] = ordered.map((resource) => {
    const baselineEstimatedTokens = estimator.count(resource.baselineText ?? "");
    const onDemandEstimatedTokens = estimator.count(resource.onDemandText ?? "");
    const estimatedTokens = baselineEstimatedTokens + onDemandEstimatedTokens;
    const key = `${resource.category}:${resource.scope}:${resource.name}`;
    const occurrence = (ids.get(key) ?? 0) + 1;
    ids.set(key, occurrence);
    return {
      id: occurrence === 1 ? key : `${key}:${occurrence}`,
      category: resource.category,
      name: resource.name,
      source: resource.source,
      scope: resource.scope,
      enabled: resource.enabled,
      disableSupported: resource.disableSupported,
      loadMode: baselineEstimatedTokens > 0 && onDemandEstimatedTokens > 0
        ? "mixed"
        : onDemandEstimatedTokens > 0 ? "on-demand" : "baseline",
      estimateStatus: resource.estimateStatus ?? "estimated",
      baselineEstimatedTokens,
      onDemandEstimatedTokens,
      estimatedTokens,
      estimatedSavingsTokens: resource.enabled && resource.disableSupported ? estimatedTokens : 0,
    };
  });
  const groups = contextBudgetCategories.map((category) => {
    const categoryItems = items.filter((item) => item.category === category);
    const enabled = categoryItems.filter((item) => item.enabled && item.estimateStatus === "estimated");
    return {
      category,
      enabledItems: categoryItems.filter((item) => item.enabled).length,
      totalItems: categoryItems.length,
      baselineEstimatedTokens: sum(enabled, (item) => item.baselineEstimatedTokens),
      onDemandEstimatedTokens: sum(enabled, (item) => item.onDemandEstimatedTokens),
      estimatedTokens: sum(enabled, (item) => item.estimatedTokens),
      availableEstimatedTokens: sum(categoryItems.filter((item) => item.estimateStatus === "estimated"), (item) => item.estimatedTokens),
      estimatedSavingsTokens: sum(categoryItems, (item) => item.estimatedSavingsTokens),
      items: categoryItems,
    };
  });
  return {
    cwd,
    estimator: estimator.metadata,
    baselineEstimatedTokens: groups.reduce((total, group) => total + group.baselineEstimatedTokens, 0),
    onDemandEstimatedTokens: groups.reduce((total, group) => total + group.onDemandEstimatedTokens, 0),
    totalEstimatedTokens: groups.reduce((total, group) => total + group.estimatedTokens, 0),
    availableEstimatedTokens: groups.reduce((total, group) => total + group.availableEstimatedTokens, 0),
    estimatedSavingsTokens: groups.reduce((total, group) => total + group.estimatedSavingsTokens, 0),
    groups,
    history: [],
  };
}
