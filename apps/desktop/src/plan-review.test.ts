import { describe, expect, it } from "vitest";
import { planReviewBlocks } from "./plan-review.js";

describe("planReviewBlocks", () => {
  it("creates deterministic content-bound anchors and preserves fenced code", () => {
    const markdown = "# Plan\n\nFirst step.\n\n```ts\nconst value = 1;\n\nconsole.log(value);\n```";
    const first = planReviewBlocks(markdown);
    const second = planReviewBlocks(markdown);

    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first[2].markdown).toContain("\n\n");
    expect(first.map((block) => block.id)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^block-1-/),
      expect.stringMatching(/^block-2-/),
      expect.stringMatching(/^block-3-/),
    ]));
  });

  it("changes the anchor when block content changes", () => {
    expect(planReviewBlocks("First")[0].id).not.toBe(planReviewBlocks("Second")[0].id);
  });
});
