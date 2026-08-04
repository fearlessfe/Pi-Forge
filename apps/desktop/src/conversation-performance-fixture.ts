import type { ChatTurn } from "./types.js";

export const performanceFixtureTurnCount = 100;
export const performanceFixtureLastMessageCharacters = 50_000;
export const performanceFixtureToolActivityCount = 20;

const markdownStressPrefix = [
  "## Long response fixture",
  "",
  "| Column | Status | Notes |",
  "| --- | --- | --- |",
  "| viewport | stable | anchor retained |",
  "| streaming | batched | within budget |",
  "",
  "```ts",
  "export const fixture = { turns: 100, virtualized: true };",
  "```",
  "",
].join("\n");

export function createConversationPerformanceFixture(): ChatTurn[] {
  return Array.from({ length: performanceFixtureTurnCount }, (_, index): ChatTurn => {
    const isLast = index === performanceFixtureTurnCount - 1;
    const activities = isLast
      ? [
          ...Array.from({ length: performanceFixtureToolActivityCount }, (__, toolIndex) => ({
            id: `fixture-tool-${toolIndex}`,
            type: "tool" as const,
            name: toolIndex % 2 === 0 ? "read" : "bash",
            args: { command: `fixture-${toolIndex}` },
            output: `fixture output ${toolIndex}`,
            status: "success" as const,
          })),
          {
            id: "fixture-message",
            type: "message" as const,
            text: markdownStressPrefix.padEnd(performanceFixtureLastMessageCharacters, "x"),
          },
        ]
      : [{ id: `fixture-message-${index}`, type: "message" as const, text: `Response ${index}` }];
    return {
      id: `fixture-turn-${index}`,
      sessionEntryId: `fixture-entry-${index}`,
      question: `Question ${index}`,
      answer: "",
      activities,
      status: isLast ? "running" : "completed",
    };
  });
}
