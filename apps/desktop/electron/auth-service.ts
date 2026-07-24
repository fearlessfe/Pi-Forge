import { randomUUID } from "node:crypto";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AuthInteraction,
  AuthPrompt as PiAuthPrompt,
  Credential,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";
import type { AuthEvent, AuthPrompt, ProviderId } from "../src/contracts.js";

type AuthRuntime = {
  getProvider(providerId: string): Provider | undefined;
  login(providerId: string, type: "oauth", interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
};

type PendingPrompt = {
  loginId: string;
  providerId: ProviderId;
  resolve(value: string): void;
  reject(error: Error): void;
  dispose(): void;
};

type ActiveLogin = {
  providerId: ProviderId;
  controller: AbortController;
};

type RuntimeFactory = () => Promise<AuthRuntime>;
type EventSink = (event: AuthEvent) => void;
type ExternalOpener = (url: string) => Promise<void> | void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicPrompt(requestId: string, prompt: PiAuthPrompt): AuthPrompt {
  return {
    requestId,
    promptType: prompt.type,
    message: prompt.message,
    placeholder: prompt.type === "select" ? undefined : prompt.placeholder,
    options: prompt.type === "select" ? [...prompt.options] : undefined,
  };
}

export class AuthService {
  private readonly active = new Map<string, ActiveLogin>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();

  constructor(
    private readonly credentials: CredentialStore,
    private readonly agentDir: string,
    private readonly emit: EventSink,
    private readonly openExternal: ExternalOpener,
    private readonly runtimeFactory?: RuntimeFactory,
  ) {}

  async login(providerId: ProviderId): Promise<string> {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) throw new Error("模型提供商格式无效。");
    if (this.active.size > 0) throw new Error("已有 OAuth 登录正在进行，请先完成或取消。");

    const runtime = await this.createRuntime();
    const provider = runtime.getProvider(providerId);
    if (!provider?.auth.oauth) throw new Error(`${provider?.name ?? providerId} 不支持 OAuth 登录。`);

    const loginId = randomUUID();
    const controller = new AbortController();
    this.active.set(loginId, { providerId, controller });
    this.emit({ type: "auth.started", loginId, providerId });

    void runtime.login(providerId, "oauth", {
      signal: controller.signal,
      prompt: (prompt) => this.prompt(loginId, providerId, prompt, controller.signal),
      notify: (event) => {
        if (event.type === "auth_url") {
          this.openTrustedUrl(event.url);
          this.emit({ type: "auth.url", loginId, providerId, url: event.url, instructions: event.instructions });
        } else if (event.type === "device_code") {
          this.openTrustedUrl(event.verificationUri);
          this.emit({
            type: "auth.device-code",
            loginId,
            providerId,
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            expiresInSeconds: event.expiresInSeconds,
          });
        } else {
          this.emit({ type: "auth.progress", loginId, providerId, message: event.message });
        }
      },
    }).then(() => {
      this.emit({ type: "auth.completed", loginId, providerId });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) this.emit({ type: "auth.cancelled", loginId, providerId });
      else this.emit({ type: "auth.error", loginId, providerId, message: errorMessage(error) });
    }).finally(() => {
      this.rejectPrompts(loginId, new Error("登录流程已结束。"));
      this.active.delete(loginId);
    });

    return loginId;
  }

  answer(requestId: string, value: string): void {
    const pending = this.pendingPrompts.get(requestId);
    if (!pending) throw new Error("该登录问题已失效。");
    pending.dispose();
    pending.resolve(value);
  }

  cancel(loginId: string): void {
    const login = this.active.get(loginId);
    if (!login) return;
    login.controller.abort();
    this.rejectPrompts(loginId, new Error("Login cancelled"));
  }

  async logout(providerId: ProviderId): Promise<void> {
    const runtime = await this.createRuntime();
    await runtime.logout(providerId);
  }

  dispose(): void {
    for (const [loginId, login] of this.active) {
      login.controller.abort();
      this.rejectPrompts(loginId, new Error("Login cancelled"));
    }
    this.active.clear();
  }

  private createRuntime(): Promise<AuthRuntime> {
    return this.runtimeFactory?.() ?? ModelRuntime.create({
      credentials: this.credentials,
      modelsPath: path.join(this.agentDir, "models.json"),
      modelsStorePath: path.join(this.agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
  }

  private prompt(
    loginId: string,
    providerId: ProviderId,
    prompt: PiAuthPrompt,
    loginSignal: AbortSignal,
  ): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        prompt.signal?.removeEventListener("abort", promptCancelled);
        loginSignal.removeEventListener("abort", loginCancelled);
        this.pendingPrompts.delete(requestId);
      };
      const promptCancelled = () => {
        finish();
        this.emit({ type: "auth.prompt-cancelled", loginId, providerId, requestId });
        reject(new Error("Login prompt cancelled"));
      };
      const loginCancelled = () => {
        finish();
        reject(new Error("Login cancelled"));
      };
      const pending: PendingPrompt = {
        loginId,
        providerId,
        resolve: (value) => { finish(); resolve(value); },
        reject: (error) => { finish(); reject(error); },
        dispose: finish,
      };
      this.pendingPrompts.set(requestId, pending);
      prompt.signal?.addEventListener("abort", promptCancelled, { once: true });
      loginSignal.addEventListener("abort", loginCancelled, { once: true });
      this.emit({ type: "auth.prompt", loginId, providerId, prompt: publicPrompt(requestId, prompt) });
    });
  }

  private rejectPrompts(loginId: string, error: Error): void {
    for (const pending of [...this.pendingPrompts.values()]) {
      if (pending.loginId === loginId) pending.reject(error);
    }
  }

  private openTrustedUrl(rawUrl: string): void {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") throw new Error("OAuth 登录地址不是受信任的 HTTPS URL。");
    void Promise.resolve(this.openExternal(url.href)).catch(() => undefined);
  }
}
