export type CompositionKeyEvent = Pick<KeyboardEvent, "isComposing" | "keyCode">;

export function isImeComposing(event: CompositionKeyEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function shouldSubmitOnEnter(
  event: CompositionKeyEvent & Pick<KeyboardEvent, "key">,
  composing = false,
): boolean {
  return event.key === "Enter" && !composing && !isImeComposing(event);
}

const MAC_OPTION_SHORTCUT_KEYS: Record<string, string> = { KeyS: "s", KeyF: "f" };

/** macOS composes Option+letter into a symbol in `event.key`, so Option shortcuts match the physical key. */
export function shortcutKey(event: Pick<KeyboardEvent, "key" | "code" | "altKey">, isMac: boolean): string {
  const physicalKey = isMac && event.altKey ? MAC_OPTION_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? event.key.toLowerCase();
}
