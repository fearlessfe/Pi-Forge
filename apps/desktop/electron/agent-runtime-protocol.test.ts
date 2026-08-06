import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { runtimeMethods } from "@pi-forge/runtime-contracts";
import { backgroundSubagentRuntimeMethods } from "./agent-runtime-protocol.js";

const desktopRuntimeMethods = [...runtimeMethods, ...backgroundSubagentRuntimeMethods];

function quotedValues(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

describe("desktop runtime protocol exhaustiveness", () => {
  it("dispatches every public runtime method in the worker", () => {
    const source = fs.readFileSync(new URL("./agent-runtime-worker.ts", import.meta.url), "utf8");
    const cases = new Set(quotedValues(source, /case "([^"]+)"/g));
    const dispatched = desktopRuntimeMethods.filter((method) => cases.has(method));
    expect(dispatched).toEqual(desktopRuntimeMethods);
  });

  it("exposes a typed client request for every public runtime method", () => {
    const source = fs.readFileSync(new URL("./agent-runtime-client.ts", import.meta.url), "utf8");
    const requestLines = source.split("\n").filter((line) => line.includes("this.request"));
    const exposed = desktopRuntimeMethods.filter((method) => requestLines.some((line) => line.includes(`"${method}"`)));
    expect(exposed).toEqual(desktopRuntimeMethods);
  });
});
