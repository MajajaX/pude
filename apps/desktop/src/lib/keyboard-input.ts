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
