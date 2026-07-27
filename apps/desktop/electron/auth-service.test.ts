import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, type AuthInteraction, type Credential, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import type { AuthEvent } from "../src/contracts.js";
import { AuthService } from "./auth-service.js";

function oauthProvider(): Provider {
  return {
    id: "test-oauth",
    name: "Test OAuth",
    auth: {
      oauth: {
        name: "Test OAuth",
        login: async () => ({ type: "oauth", access: "", refresh: "", expires: 0 }),
        refresh: async (credential: OAuthCredential) => credential,
        toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
      },
    },
    getModels: () => [],
    stream: vi.fn(),
    streamSimple: vi.fn(),
  } as unknown as Provider;
}

describe("AuthService", () => {
  it("bridges select, device-code, browser and completion events", async () => {
    const events: AuthEvent[] = [];
    const opened: string[] = [];
    let interaction!: AuthInteraction;
    const runtime = {
      getProvider: () => oauthProvider(),
      login: async (_providerId: string, _type: "oauth", value: AuthInteraction): Promise<Credential> => {
        interaction = value;
        const method = await value.prompt({
          type: "select",
          message: "Choose login method",
          options: [{ id: "device", label: "Device code" }],
        });
        expect(method).toBe("device");
        value.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://example.com/device" });
        value.notify({ type: "auth_url", url: "https://example.com/login" });
        return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
      },
      logout: vi.fn(),
    };
    const service = new AuthService(new InMemoryCredentialStore(), "/tmp/pi-desktop-auth-test", (event) => events.push(event), (url) => { opened.push(url); }, async () => runtime);

    const loginId = await service.login("test-oauth");
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.prompt")).toBe(true));
    const prompt = events.find((event) => event.type === "auth.prompt");
    expect(prompt?.type).toBe("auth.prompt");
    if (prompt?.type === "auth.prompt") service.answer(prompt.prompt.requestId, "device");
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.completed")).toBe(true));

    expect(interaction.signal?.aborted).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "auth.started", loginId }),
      expect.objectContaining({ type: "auth.device-code", userCode: "ABCD-EFGH" }),
      expect.objectContaining({ type: "auth.url" }),
      expect.objectContaining({ type: "auth.completed" }),
    ]));
    expect(opened).toEqual(["https://example.com/device", "https://example.com/login"]);
  });

  it("cancels an in-flight login and rejects untrusted URLs", async () => {
    const events: AuthEvent[] = [];
    const runtime = {
      getProvider: () => oauthProvider(),
      login: async (_providerId: string, _type: "oauth", interaction: AuthInteraction): Promise<Credential> => {
        interaction.notify({ type: "auth_url", url: "http://untrusted.example/login" });
        return { type: "oauth", access: "", refresh: "", expires: 0 };
      },
      logout: vi.fn(),
    };
    const service = new AuthService(new InMemoryCredentialStore(), "/tmp/pi-desktop-auth-test", (event) => events.push(event), vi.fn(), async () => runtime);
    await service.login("test-oauth");
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.error")).toBe(true));
    expect(events.find((event) => event.type === "auth.error")).toMatchObject({ message: expect.stringContaining("HTTPS") });
  });

  it("validates providers and prevents overlapping OAuth flows", async () => {
    let interaction!: AuthInteraction;
    const runtime = {
      getProvider: (providerId: string) => providerId === "plain" ? ({ id: "plain", name: "Plain", auth: {}, getModels: () => [] } as unknown as Provider) : oauthProvider(),
      login: async (_providerId: string, _type: "oauth", value: AuthInteraction): Promise<Credential> => {
        interaction = value;
        return await new Promise<Credential>((_resolve, reject) => {
          value.signal?.addEventListener("abort", () => reject(new Error("aborted by user")), { once: true });
        });
      },
      logout: vi.fn(),
    };
    const events: AuthEvent[] = [];
    const service = new AuthService(new InMemoryCredentialStore(), "/tmp/pi-desktop-auth-test", (event) => events.push(event), vi.fn(), async () => runtime);

    await expect(service.login("not valid!")).rejects.toThrow("格式无效");
    await expect(service.login("plain")).rejects.toThrow("不支持 OAuth");
    const loginId = await service.login("test-oauth");
    expect(interaction.signal?.aborted).toBe(false);
    await expect(service.login("test-oauth")).rejects.toThrow("已有 OAuth 登录");
    service.cancel("missing-login");
    service.cancel(loginId);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "auth.cancelled", loginId })));
  });

  it("forwards progress, text prompts, logout, and safely ignores opener failures", async () => {
    const events: AuthEvent[] = [];
    const logout = vi.fn(async () => undefined);
    const runtime = {
      getProvider: () => oauthProvider(),
      login: async (_providerId: string, _type: "oauth", interaction: AuthInteraction): Promise<Credential> => {
        interaction.notify({ type: "progress", message: "Waiting for authorization" });
        interaction.notify({ type: "auth_url", url: "https://example.com/oauth" });
        const code = await interaction.prompt({ type: "text", message: "Paste code", placeholder: "ABC-123" });
        expect(code).toBe("verified-code");
        return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
      },
      logout,
    };
    const service = new AuthService(
      new InMemoryCredentialStore(),
      "/tmp/pi-desktop-auth-test",
      (event) => events.push(event),
      async () => { throw new Error("browser unavailable"); },
      async () => runtime,
    );

    expect(() => service.answer("missing-request", "value")).toThrow("已失效");
    await service.login("test-oauth");
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.prompt")).toBe(true));
    const prompt = events.find((event) => event.type === "auth.prompt");
    expect(prompt).toMatchObject({
      type: "auth.prompt",
      prompt: { promptType: "text", placeholder: "ABC-123", options: undefined },
    });
    if (prompt?.type === "auth.prompt") service.answer(prompt.prompt.requestId, "verified-code");
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.completed")).toBe(true));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "auth.progress", message: "Waiting for authorization" }),
      expect.objectContaining({ type: "auth.url", url: "https://example.com/oauth" }),
    ]));

    await service.logout("test-oauth");
    expect(logout).toHaveBeenCalledWith("test-oauth");
  });

  it("propagates prompt-level cancellation and disposes every active login", async () => {
    const events: AuthEvent[] = [];
    const promptController = new AbortController();
    const runtime = {
      getProvider: () => oauthProvider(),
      login: async (_providerId: string, _type: "oauth", interaction: AuthInteraction): Promise<Credential> => {
        await interaction.prompt({ type: "text", message: "Temporary prompt", signal: promptController.signal });
        return { type: "oauth", access: "", refresh: "", expires: 0 };
      },
      logout: vi.fn(),
    };
    const service = new AuthService(new InMemoryCredentialStore(), "/tmp/pi-desktop-auth-test", (event) => events.push(event), vi.fn(), async () => runtime);

    await service.login("test-oauth");
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.prompt")).toBe(true));
    promptController.abort();
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.prompt-cancelled")).toBe(true));
    await vi.waitFor(() => expect(events.some((event) => event.type === "auth.error")).toBe(true));
    service.dispose();

    const disposeEvents: AuthEvent[] = [];
    const blockingRuntime = {
      getProvider: () => oauthProvider(),
      login: async (_providerId: string, _type: "oauth", interaction: AuthInteraction): Promise<Credential> => await new Promise<Credential>((_resolve, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("disposed")), { once: true });
      }),
      logout: vi.fn(),
    };
    const disposable = new AuthService(new InMemoryCredentialStore(), "/tmp/pi-desktop-auth-test", (event) => disposeEvents.push(event), vi.fn(), async () => blockingRuntime);
    await disposable.login("test-oauth");
    disposable.dispose();
    await vi.waitFor(() => expect(disposeEvents.some((event) => event.type === "auth.cancelled")).toBe(true));
  });
});
