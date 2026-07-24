export type ShortcutEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function isPrimaryShortcut(event: ShortcutEvent, key: string): boolean {
  return (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && event.key.toLocaleLowerCase() === key.toLocaleLowerCase();
}

export function shouldSubmitOnEnter(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function shortcutLabel(key: string): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  return `${isMac ? "⌘" : "Ctrl+"}${key.toLocaleUpperCase()}`;
}
