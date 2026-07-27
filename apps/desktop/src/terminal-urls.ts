const ansiSequence = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/g;
const localServiceUrl = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:\/[^\s<>"'`\])}]*)?/gi;

function normalizeDetectedUrl(value: string): string | undefined {
  const trimmed = value.replace(/[.,;!?]+$/, "");
  try {
    const url = new URL(trimmed);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function stripTerminalAnsi(value: string): string {
  return value.replace(ansiSequence, "");
}

export function detectLocalServiceUrls(value: string): string[] {
  const matches = stripTerminalAnsi(value).match(localServiceUrl) ?? [];
  return [...new Set(matches.flatMap((match) => {
    const normalized = normalizeDetectedUrl(match);
    return normalized ? [normalized] : [];
  }))];
}
