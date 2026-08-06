# `@pi-forge/runtime-sdk`

Transport-neutral SDK for Pi Forge Runtime protocol v1. It provides:

- a validating request/response/event `RuntimeClient`;
- an Agent-side `RuntimeHost` with fail-closed envelope validation;
- `defineAgent()` manifest validation and a small handler factory;
- capability negotiation, request timeouts, structured protocol errors, and event subscriptions.

The SDK does not expose Electron, credentials, MCP, browser, filesystem, or other privileged desktop host services. Applications decide how validated envelopes are transported—for example over child-process IPC, WebSocket, or a local message channel.

```ts
import { defineAgent, RuntimeHost } from "@pi-forge/runtime-sdk";

const agent = defineAgent({
  manifest: {
    id: "example-agent",
    name: "Example Agent",
    version: "1.0.0",
    protocolVersion: 1,
    capabilities: ["runtime.rpc", "runtime.events", "runtime.heartbeat"],
  },
  create: ({ emit }) => ({
    send: async (prompt, cwd, conversationId) => {
      // Validate application-specific values before use.
      const runId = crypto.randomUUID();
      await emit({ type: "run.started", runId, conversationId: String(conversationId), provider: "custom", model: "custom", cwd: String(cwd) });
      await emit({ type: "message.delta", runId, text: `Received: ${String(prompt)}` });
      await emit({ type: "run.completed", runId });
      return runId;
    },
  }),
});

const host = new RuntimeHost((message) => transport.send(message), agent);
transport.onMessage((message) => void host.accept(message));
await host.start();
```

See `templates/basic-agent` for a complete compilable starting point and `@pi-forge/runtime-contracts/COMPATIBILITY.md` for the v1 policy.
