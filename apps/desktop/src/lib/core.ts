export function hasUnsavedChanges(content: string, savedContent: string): boolean {
  return content !== savedContent;
}

/** Keep pinned tabs to the left while preserving order within each group. */
export function orderTabsByPinned<T extends { pinned?: boolean }>(tabs: readonly T[]): T[] {
  return tabs.filter((tab) => tab.pinned === true).concat(tabs.filter((tab) => tab.pinned !== true));
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

export function gitStatusLabel(indexStatus: string | null, worktreeStatus: string | null): string {
  return `${indexStatus ?? " "}${worktreeStatus ?? " "}`.trim() || "clean";
}
