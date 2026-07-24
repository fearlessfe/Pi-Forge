import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { captureAgentSessionEvent } from "./agent-event-adapter.js";

describe("captureAgentSessionEvent", () => {
  it("preserves event identity and sequence in an IPC-safe payload", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", apiKey: "never-forward" },
      assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
    } as unknown as AgentSessionEvent;

    const captured = captureAgentSessionEvent(event, 7);
    expect(captured.sequence).toBe(7);
    expect(captured.eventType).toBe("message_update");
    expect(captured.timestamp).toBeTypeOf("number");
    expect(captured.payload).toMatchObject({
      type: "message_update",
      message: { apiKey: "[REDACTED]" },
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
  });

  it("serializes circular and non-JSON values without breaking IPC", () => {
    const payload: Record<string, unknown> = { type: "entry_appended", count: 1n };
    payload.self = payload;
    const captured = captureAgentSessionEvent(payload as unknown as AgentSessionEvent, 1);
    expect(captured.payload).toMatchObject({ count: "1", self: "[Circular]" });
  });
});
