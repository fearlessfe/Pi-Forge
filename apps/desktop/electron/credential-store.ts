import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type StoredCredentialsFile = {
  version: 1;
  encrypted: string;
};

export type CredentialStorageEncryption = Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">;

function cloneCredential(credential: Credential | undefined): Credential | undefined {
  return credential ? JSON.parse(JSON.stringify(credential)) as Credential : undefined;
}

function validProviderId(providerId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(providerId);
}

export class EncryptedCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private readonly credentials = new Map<string, Credential>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(userDataPath: string, private readonly encryption: CredentialStorageEncryption = safeStorage) {
    this.filePath = path.join(userDataPath, "credentials.enc.json");
    this.load();
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return cloneCredential(this.credentials.get(providerId));
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (!validProviderId(providerId)) return Promise.reject(new Error("模型提供商格式无效。"));
    return this.enqueue(providerId, async () => {
      const current = cloneCredential(this.credentials.get(providerId));
      const next = await update(current);
      if (next !== undefined) {
        this.credentials.set(providerId, cloneCredential(next) as Credential);
        try {
          this.persist();
        } catch (error) {
          if (current) this.credentials.set(providerId, current);
          else this.credentials.delete(providerId);
          throw error;
        }
        return cloneCredential(next);
      }
      return current;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      const current = this.credentials.get(providerId);
      if (!this.credentials.delete(providerId)) return;
      try {
        this.persist();
      } catch (error) {
        if (current) this.credentials.set(providerId, current);
        throw error;
      }
    });
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = (async () => {
      await previous.catch(() => undefined);
      return task();
    })();
    this.chains.set(providerId, next.catch(() => undefined));
    return next;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    this.requireEncryption("无法读取已保存的模型凭据");
    const stored = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as StoredCredentialsFile;
    if (stored.version !== 1 || typeof stored.encrypted !== "string") throw new Error("模型凭据文件格式无效。");
    const plaintext = this.encryption.decryptString(Buffer.from(stored.encrypted, "base64"));
    const parsed = JSON.parse(plaintext) as Record<string, Credential>;
    for (const [providerId, credential] of Object.entries(parsed)) {
      if (validProviderId(providerId) && (credential?.type === "api_key" || credential?.type === "oauth")) {
        this.credentials.set(providerId, credential);
      }
    }
  }

  private persist(): void {
    this.requireEncryption("模型凭据未保存");
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    const plaintext = JSON.stringify(Object.fromEntries(this.credentials));
    const stored: StoredCredentialsFile = {
      version: 1,
      encrypted: this.encryption.encryptString(plaintext).toString("base64"),
    };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporaryPath, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  private requireEncryption(action: string): void {
    if (!this.encryption.isEncryptionAvailable()) throw new Error(`操作系统安全存储当前不可用，${action}。`);
  }
}
