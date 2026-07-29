import type { ModelCatalogEntry, ModelPricing } from "../src/contracts.js";

export type ProtocolModelMetadata = {
  protocol: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  sourceUrl?: string;
  supportsImages?: boolean;
};

const openAiPricingUrl = "https://developers.openai.com/api/docs/pricing";

// Deliberately finite: only exact protocol + model-id pairs belong here.
// GPT-5.6 Sol pricing is USD / 1M tokens for standard processing.
const fixedMetadata: ProtocolModelMetadata[] = [
  ...["openai-responses", "openai-completions"].flatMap((protocol) => [
    "gpt-5.6",
    "gpt-5.6-sol",
  ].map((modelId) => ({
    protocol,
    modelId,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    sourceUrl: openAiPricingUrl,
  }))),
];

export function protocolModelKey(protocol: string, modelId: string): string {
  return `${protocol}\u0000${modelId}`;
}

export function buildProtocolModelMetadataIndex(models: ModelCatalogEntry[]): Map<string, ProtocolModelMetadata> {
  const index = new Map<string, ProtocolModelMetadata>();
  for (const model of models) {
    if (!model.protocol) continue;
    index.set(protocolModelKey(model.protocol, model.id), {
      protocol: model.protocol,
      modelId: model.id,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens ?? 0,
      pricing: model.pricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      sourceUrl: model.metadataSourceUrl,
      supportsImages: model.supportsImages,
    });
  }
  for (const metadata of fixedMetadata) {
    index.set(protocolModelKey(metadata.protocol, metadata.modelId), metadata);
  }
  return index;
}

export function matchProtocolModelMetadata(
  index: ReadonlyMap<string, ProtocolModelMetadata>,
  protocol: string,
  modelId: string,
): ProtocolModelMetadata | undefined {
  return index.get(protocolModelKey(protocol, modelId));
}

export function fixedProtocolModelMetadata(protocol: string, modelId: string): ProtocolModelMetadata | undefined {
  return fixedMetadata.find((metadata) => metadata.protocol === protocol && metadata.modelId === modelId);
}
