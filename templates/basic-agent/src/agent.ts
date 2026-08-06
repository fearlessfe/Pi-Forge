import { randomUUID } from "node:crypto";
import { defineAgent } from "@pi-forge/runtime-sdk";

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

export const basicAgent = defineAgent({
  manifest: {
    id: "pi-forge-basic-agent",
    name: "Pi Forge Basic Agent",
    version: "1.0.0",
    protocolVersion: 1,
    capabilities: ["runtime.rpc", "runtime.events", "runtime.heartbeat"],
  },
  create: ({ emit }) => ({
    updateConfiguration: async () => undefined,
    send: async (promptInput, cwdInput, conversationIdInput) => {
      if (typeof promptInput !== "string") throw new Error("prompt must be a string.");
      const cwd = optionalString(cwdInput, "cwd") ?? process.cwd();
      const conversationId = optionalString(conversationIdInput, "conversationId") ?? randomUUID();
      const runId = randomUUID();
      await emit({ type: "run.started", runId, conversationId, provider: "template", model: "echo", cwd });
      await emit({ type: "user.message.started", runId, conversationId, message: promptInput });
      await emit({ type: "message.delta", runId, conversationId, text: `Echo: ${promptInput}` });
      await emit({ type: "run.completed", runId, conversationId });
      return runId;
    },
  }),
});
