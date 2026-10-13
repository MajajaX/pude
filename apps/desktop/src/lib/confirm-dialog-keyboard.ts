import { isImeComposing } from "./keyboard-input";

export type ConfirmDialogKeyEvent = Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">;

export type ConfirmDialogKeyAction = "none" | "cancel" | "prevent";

export function confirmDialogKeyAction(event: ConfirmDialogKeyEvent, busy: boolean): ConfirmDialogKeyAction {
  if (event.key === "Enter" && isImeComposing(event)) return "prevent";
  if (event.key === "Escape") return busy ? "prevent" : "cancel";
  return "none";
}
