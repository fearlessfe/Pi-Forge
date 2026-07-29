import type { ProviderId } from "../contracts";

export function parseModelValue(value: string): [ProviderId, string] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string"
      || !parsed[0]
      || !parsed[1]
    ) return null;
    return [parsed[0], parsed[1]];
  } catch {
    return null;
  }
}
