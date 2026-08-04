import { describe, expect, it } from "vitest";
import { applyAgentEvents } from "./agent-event-state.js";
import {
  createConversationPerformanceFixture,
  performanceFixtureLastMessageCharacters,
  performanceFixtureToolActivityCount,
  performanceFixtureTurnCount,
} from "./conversation-performance-fixture.js";
import {
  buildConversationTurnLayout,
  buildConversationWindow,
  conversationAnchorIndex,
  conversationMountedTurnBudget,
  conversationStreamingBatchDelayMs,
  conversationStreamingRefreshBudgetMs,
  conversationTurnDomBudget,
  pinnedConversationTurnIndices,
} from "./conversation-window.js";

describe("conversation viewport window", () => {
  it("moves with the viewport while enforcing the explicit DOM turn budget", () => {
    const turns = createConversationPerformanceFixture();
    const layout = buildConversationTurnLayout(turns, new Map());
    const top = buildConversationWindow(layout, 0, 720);
    const middle = buildConversationWindow(layout, layout.totalHeight / 2, 720);
    const bottom = buildConversationWindow(layout, layout.totalHeight - 720, 720);

    expect(top.indices.length).toBeLessThanOrEqual(conversationTurnDomBudget);
    expect(middle.indices.length).toBeLessThanOrEqual(conversationTurnDomBudget);
    expect(bottom.indices.length).toBeLessThanOrEqual(conversationTurnDomBudget);
    expect(top.indices[0]).toBe(0);
    expect(middle.indices[0]).toBeGreaterThan(top.indices.at(-1)!);
    expect(bottom.indices).toContain(performanceFixtureTurnCount - 1);
  });

  it("uses measured dynamic heights and exposes a stable upward-reading anchor", () => {
    const turns = createConversationPerformanceFixture();
    const measurements = new Map([[turns[0].id, 1_200], [turns[1].id, 180]]);
    const before = buildConversationTurnLayout(turns, measurements);
    const anchor = conversationAnchorIndex(before, 1_250);
    const anchorOffset = before.offsets[anchor] - 1_250;
    measurements.set(turns[0].id, 1_600);
    const after = buildConversationTurnLayout(turns, measurements);
    const restoredScrollTop = after.offsets[anchor] - anchorOffset;

    expect(anchor).toBe(1);
    expect(restoredScrollTop).toBe(1_650);
  });

  it("keeps an open diff, running turn, and pending question mounted", () => {
    const turns = createConversationPerformanceFixture();
    turns[3] = {
      ...turns[3],
      activities: [{ id: "question", type: "question", question: "Continue?", options: [], status: "pending" }],
    };
    turns[5] = {
      ...turns[5],
      fileChanges: [{ id: "open-diff", runId: "fixture-run", callId: "fixture-call", path: "/workspace/a.ts", relativePath: "a.ts", patch: "+change", kind: "modified", afterHash: "after", status: "pending", revertible: true }],
    };
    const layout = buildConversationTurnLayout(turns, new Map());
    const pinned = pinnedConversationTurnIndices(turns, "open-diff");
    const window = buildConversationWindow(layout, layout.totalHeight / 2, 600, pinned);

    expect(window.indices).toEqual(expect.arrayContaining([3, 5, performanceFixtureTurnCount - 1]));
    expect(window.indices.length).toBeLessThanOrEqual(conversationMountedTurnBudget(pinned.length));
  });

  it("retains every safety-critical turn even when more than twelve questions are pending", () => {
    const turns = createConversationPerformanceFixture();
    const pendingIndices = Array.from({ length: 16 }, (_, index) => index * 2);
    for (const index of pendingIndices) {
      turns[index] = {
        ...turns[index],
        activities: [{ id: `question-${index}`, type: "question", question: "Continue?", options: [], status: "pending" }],
      };
    }
    const layout = buildConversationTurnLayout(turns, new Map());
    const pinned = pinnedConversationTurnIndices(turns);
    const window = buildConversationWindow(layout, layout.totalHeight - 600, 600, pinned);

    expect(pinned).toEqual(expect.arrayContaining(pendingIndices));
    expect(window.indices).toEqual(expect.arrayContaining(pendingIndices));
    expect(window.indices.length).toBeLessThanOrEqual(conversationMountedTurnBudget(pinned.length));
  });
});

describe("repeatable PERF-01 conversation fixture", () => {
  it("contains 100 turns, a 50k Markdown tail, and 20 tool activities", () => {
    const turns = createConversationPerformanceFixture();
    const last = turns.at(-1)!;
    const message = last.activities.find((activity) => activity.type === "message");
    expect(turns).toHaveLength(performanceFixtureTurnCount);
    expect(message?.type === "message" ? message.text.length : 0).toBe(performanceFixtureLastMessageCharacters);
    expect(message?.type === "message" ? message.text : "").toContain("| Column | Status | Notes |");
    expect(message?.type === "message" ? message.text : "").toContain("```ts");
    expect(last.activities.filter((activity) => activity.type === "tool")).toHaveLength(performanceFixtureToolActivityCount);
  });

  it("coalesces a fixture-sized streaming refresh within the 60ms budget", () => {
    const turns = createConversationPerformanceFixture();
    const events = Array.from({ length: 250 }, (_, index) => ({
      type: "message.delta" as const,
      runId: "fixture-run",
      text: String(index % 10),
    }));
    turns[turns.length - 1] = { ...turns.at(-1)!, runId: "fixture-run" };
    const startedAt = performance.now();
    const updated = applyAgentEvents(turns, events);
    const elapsed = performance.now() - startedAt;

    expect(conversationStreamingBatchDelayMs).toBeLessThanOrEqual(conversationStreamingRefreshBudgetMs);
    expect(elapsed).toBeLessThan(conversationStreamingRefreshBudgetMs);
    const lastMessage = updated.at(-1)!.activities.at(-1);
    expect(lastMessage?.type === "message" ? lastMessage.text.length : 0)
      .toBe(performanceFixtureLastMessageCharacters + events.length);
  });
});
