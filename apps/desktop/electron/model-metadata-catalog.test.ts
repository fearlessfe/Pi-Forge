import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../src/contracts.js";
import {
  buildProtocolModelMetadataIndex,
  matchProtocolModelMetadata,
} from "./model-metadata-catalog.js";

describe("protocol + model metadata matching", () => {
  it("matches the finite GPT-5.6 Sol metadata for both supported OpenAI protocols", () => {
    const index = buildProtocolModelMetadataIndex([]);

    for (const protocol of ["openai-responses", "openai-completions"]) {
      expect(matchProtocolModelMetadata(index, protocol, "gpt-5.6-sol")).toMatchObject({
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
        pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      });
    }
  });

  it("does not guess across protocols or similar model ids", () => {
    const index = buildProtocolModelMetadataIndex([]);
    expect(matchProtocolModelMetadata(index, "anthropic-messages", "gpt-5.6-sol")).toBeUndefined();
    expect(matchProtocolModelMetadata(index, "openai-responses", "gpt-5.6-sol-preview")).toBeUndefined();
  });

  it("indexes the finite built-in catalog by exact protocol and model id", () => {
    const model: ModelCatalogEntry = {
      id: "vendor-model",
      name: "Vendor Model",
      reasoning: true,
      protocol: "vendor-protocol",
      contextWindow: 200_000,
      maxOutputTokens: 20_000,
      pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
    };
    const index = buildProtocolModelMetadataIndex([model]);

    expect(matchProtocolModelMetadata(index, "vendor-protocol", "vendor-model")).toMatchObject({
      contextWindow: 200_000,
      pricing: { input: 2, output: 8 },
    });
    expect(matchProtocolModelMetadata(index, "other-protocol", "vendor-model")).toBeUndefined();
  });

  it("propagates the image capability flag from catalog entries", () => {
    const vision: ModelCatalogEntry = {
      id: "vision-model",
      name: "Vision Model",
      reasoning: true,
      protocol: "vendor-protocol",
      contextWindow: 100_000,
      supportsImages: true,
    };
    const textOnly: ModelCatalogEntry = { ...vision, id: "text-model", supportsImages: false };
    const unknown: ModelCatalogEntry = { ...vision, id: "unknown-model", supportsImages: undefined };
    const index = buildProtocolModelMetadataIndex([vision, textOnly, unknown]);

    expect(matchProtocolModelMetadata(index, "vendor-protocol", "vision-model")?.supportsImages).toBe(true);
    expect(matchProtocolModelMetadata(index, "vendor-protocol", "text-model")?.supportsImages).toBe(false);
    expect(matchProtocolModelMetadata(index, "vendor-protocol", "unknown-model")?.supportsImages).toBeUndefined();
    expect(matchProtocolModelMetadata(index, "openai-responses", "gpt-5.6-sol")?.supportsImages).toBeUndefined();
  });
});
