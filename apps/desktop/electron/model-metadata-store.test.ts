import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "../src/contracts.js";
import { ModelMetadataStore } from "./model-metadata-store.js";

const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-model-metadata-"));
  temporaryDirectories.push(directory);
  return directory;
}

const catalog: ProviderCatalogEntry[] = [{
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  kind: "builtin",
  supportsApiKey: true,
  supportsOAuth: false,
  models: [{
    id: "gpt-test",
    name: "GPT Test",
    reasoning: true,
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    pricing: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 },
    metadataSource: "official",
  }],
}];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("ModelMetadataStore", () => {
  it("persists user overrides and applies them over refreshed official data", () => {
    const directory = createDirectory();
    const store = new ModelMetadataStore(directory);
    store.save("openai", "gpt-test", {
      name: "Internal GPT",
      contextWindow: 256_000,
      maxOutputTokens: 32_000,
      pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
    });

    const reloaded = new ModelMetadataStore(directory);
    expect(reloaded.apply(catalog)[0].models[0]).toMatchObject({
      name: "Internal GPT",
      contextWindow: 256_000,
      maxOutputTokens: 32_000,
      pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
      metadataSource: "official",
      isMetadataOverridden: true,
    });
  });

  it("restores official values when an override is reset", () => {
    const store = new ModelMetadataStore(createDirectory());
    store.save("openai", "gpt-test", {
      name: "Override",
      contextWindow: 1,
      maxOutputTokens: 1,
      pricing: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    });
    store.reset("openai", "gpt-test");

    expect(store.apply(catalog)[0].models[0]).toMatchObject({
      name: "GPT Test",
      contextWindow: 128_000,
      isMetadataOverridden: false,
    });
  });

  it("rejects invalid prices instead of persisting them", () => {
    const directory = createDirectory();
    const store = new ModelMetadataStore(directory);
    expect(() => store.save("openai", "gpt-test", {
      name: "Bad price",
      contextWindow: 128_000,
      maxOutputTokens: 1,
      pricing: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })).toThrow("输入价格");
    expect(fs.existsSync(path.join(directory, "model-metadata.json"))).toBe(false);
  });
});
