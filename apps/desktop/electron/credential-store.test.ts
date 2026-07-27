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
  vi.restoreAllMocks();
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

  it("starts empty when saved credentials can no longer be decrypted", async () => {
    const userData = directory();
    const credentialPath = path.join(userData, "credentials.enc.json");
    fs.writeFileSync(credentialPath, JSON.stringify({ version: 1, encrypted: "dW5yZWFkYWJsZQ==" }));
    const unreadable: CredentialStorageEncryption = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`replacement:${value}`, "utf8"),
      decryptString: () => {
        throw new Error("ciphertext belongs to another keychain");
      },
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const store = new EncryptedCredentialStore(userData, unreadable);

    await expect(store.list()).resolves.toEqual([]);
    expect(fs.existsSync(credentialPath)).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("authentication is required again"),
      "ciphertext belongs to another keychain",
    );

    await store.modify("openai", async () => ({ type: "api_key", key: "new-secret" }));
    const replaced = JSON.parse(fs.readFileSync(credentialPath, "utf8")) as { encrypted: string };
    expect(Buffer.from(replaced.encrypted, "base64").toString("utf8")).toContain("replacement:");
  });
});
