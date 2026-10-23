import { translateMessage } from "./i18n";

export function hasUnsavedChanges(content: string, savedContent: string): boolean {
  return content !== savedContent;
}

/** Keep pinned tabs to the left while preserving order within each group. */
export function orderTabsByPinned<T extends { pinned?: boolean }>(tabs: readonly T[]): T[] {
  return tabs.filter((tab) => tab.pinned === true).concat(tabs.filter((tab) => tab.pinned !== true));
}

/** The error's message, translated when it is a known message, or the fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  return translateMessage(untranslatedErrorMessage(error) ?? fallback);
}

function untranslatedErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
}

export function gitStatusLabel(indexStatus: string | null, worktreeStatus: string | null): string {
  return `${indexStatus ?? " "}${worktreeStatus ?? " "}`.trim() || "clean";
}
