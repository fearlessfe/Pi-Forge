import { describe, expect, it } from "vitest";
import type { RuntimeClientEnvelope, RuntimeServerEnvelope } from "@pi-forge/runtime-contracts";
import { RuntimeClient, RuntimeHost } from "@pi-forge/runtime-sdk";
import { basicAgent } from "./agent.js";

describe("basic Agent template", () => {
  it("runs a complete v1 Agent turn", async () => {
    let host: RuntimeHost;
    const events: string[] = [];
    const client = new RuntimeClient((message: RuntimeClientEnvelope) => host.accept(message));
    client.onEvent((event) => events.push(event.type));
    host = new RuntimeHost((message: RuntimeServerEnvelope) => client.accept(message), basicAgent, { pid: 1 });
    await host.start();

    await expect(client.request<string>("send", "hello", "/workspace", "conversation-template")).resolves.toEqual(expect.any(String));
    expect(events).toEqual(["run.started", "user.message.started", "message.delta", "run.completed"]);
  });
});
