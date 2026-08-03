export type PlanReviewBlock = {
  id: string;
  markdown: string;
  quote: string;
};

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function planReviewBlocks(markdown: string): PlanReviewBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence = "";
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = "";
      current.push(line);
      continue;
    }
    if (!fence && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks.map((block, index) => ({
    id: `block-${index + 1}-${hashText(block)}`,
    markdown: block,
    quote: block.replace(/\s+/g, " ").slice(0, 500),
  }));
}
