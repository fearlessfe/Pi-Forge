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

import { EncryptedCredentialStore, type CredentialStorageEncryption } from "./credential-store.js";

const directories: string[] = [];
const encryption: CredentialStorageEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`cipher:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^cipher:/, ""),
};

function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-credentials-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("EncryptedCredentialStore", () => {
  it("encrypts API key and OAuth credentials and reloads them", async () => {
    const userData = directory();
    const store = new EncryptedCredentialStore(userData, encryption);
    await store.modify("openai", async () => ({ type: "api_key", key: "sk-secret" }));
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: 1234,
      accountId: "account-1",
    }));

    const raw = fs.readFileSync(path.join(userData, "credentials.enc.json"), "utf8");
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("access-secret");
    expect(raw).not.toContain("refresh-secret");

    const reloaded = new EncryptedCredentialStore(userData, encryption);
    await expect(reloaded.read("openai")).resolves.toEqual({ type: "api_key", key: "sk-secret" });
    await expect(reloaded.read("openai-codex")).resolves.toMatchObject({ type: "oauth", accountId: "account-1" });
    await expect(reloaded.list()).resolves.toEqual(expect.arrayContaining([
      { providerId: "openai", type: "api_key" },
      { providerId: "openai-codex", type: "oauth" },
    ]));
  });

  it("serializes refresh-token rotation and logout", async () => {
    const store = new EncryptedCredentialStore(directory(), encryption);
    await store.modify("xai", async () => ({ type: "oauth", access: "a1", refresh: "r1", expires: 1 }));
    await Promise.all([
      store.modify("xai", async (current) => ({ ...current!, access: "a2", refresh: "r2" })),
      store.modify("xai", async (current) => {
        if (current?.type !== "oauth") throw new Error("Expected OAuth credential");
        return { ...current, access: `${current.access}-final` };
      }),
    ]);
    await expect(store.read("xai")).resolves.toMatchObject({ access: "a2-final", refresh: "r2" });
    await store.delete("xai");
    await expect(store.read("xai")).resolves.toBeUndefined();
  });

  it("refuses to persist secrets when OS encryption is unavailable", async () => {
    const unavailable: CredentialStorageEncryption = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    };
    const store = new EncryptedCredentialStore(directory(), unavailable);
    await expect(store.modify("openai", async () => ({ type: "api_key", key: "secret" })))
      .rejects.toThrow("操作系统安全存储当前不可用");
  });
});
