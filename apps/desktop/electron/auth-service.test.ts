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
});
